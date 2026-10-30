// 매장 택배비 업로드 API (courier 전용 스키마만 사용)
import postgres from "npm:postgres@3.4.5";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3 });
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const BUCKET = "courier-receipts";
const CAP = 250000;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const fail = (msg: string, status = 400) => json({ error: msg }, status);

// ---- 날짜 (한국시간 기준) ----
function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); } // UTC 필드로 KST 값을 읽음
function ym(d: Date) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; }
function addMonth(m: string, n: number) {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return ym(d);
}
// m월분 마감: 다음달 5일 23:59:59 KST
function deadlineOf(m: string) { return `${addMonth(m, 1)}-05`; }
function isOpen(m: string) {
  const now = kstNow();
  const today = now.toISOString().slice(0, 10);
  const cur = ym(now);
  if (m > cur) return false;             // 미래 월 불가
  return today <= deadlineOf(m);         // 마감일 당일까지 가능
}
function openMonths() {
  const cur = ym(kstNow());
  return [addMonth(cur, -1), cur].filter(isOpen);
}
const support = (amount: number) => -Math.min(amount / 2, CAP);
const validMonth = (m: unknown) => typeof m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);

async function storeByToken(t: unknown) {
  if (typeof t !== "string" || !/^[0-9a-f]{32}$/.test(t)) return null;
  const r = await sql`select id, code, name from courier.stores where token = ${t} and active`;
  return r[0] ?? null;
}
async function isAdmin(t: unknown) {
  if (typeof t !== "string" || !/^[0-9a-f]{48}$/.test(t)) return false;
  const r = await sql`select 1 from courier.admin_tokens where token = ${t}`;
  return r.length > 0;
}
async function signed(paths: string[]) {
  if (!paths.length) return {} as Record<string, string>;
  const { data } = await sb.storage.from(BUCKET).createSignedUrls(paths, 3600);
  const out: Record<string, string> = {};
  (data ?? []).forEach((d) => { if (d.path && d.signedUrl) out[d.path] = d.signedUrl; });
  return out;
}
async function photosFor(ids: string[]) {
  if (!ids.length) return [];
  return await sql`select id, submission_id, path from courier.photos where submission_id = any(${ids}::uuid[]) order by created_at`;
}

// ---- 매장 ----
async function storeInfo(body: any) {
  const st = await storeByToken(body.token);
  if (!st) return fail("링크가 올바르지 않습니다. 본사에 문의해 주세요.", 403);
  const subs = await sql`
    select id, to_char(month,'YYYY-MM') as month, qty, amount::float8 as amount, support::float8 as support,
           memo, status, reject_reason, updated_at
    from courier.submissions where store_id = ${st.id} order by month desc limit 12`;
  const photos = await photosFor(subs.map((s: any) => s.id));
  const urls = await signed(photos.map((p: any) => p.path));
  const open = openMonths();
  const list = subs.map((s: any) => {
    const editable = s.status !== "confirmed" && (open.includes(s.month) || s.status === "rejected");
    return {
      ...s, editable, deadline: deadlineOf(s.month),
      photos: photos.filter((p: any) => p.submission_id === s.id).map((p: any) => ({ id: p.id, url: urls[p.path] ?? null, pdf: p.path.endsWith(".pdf") })),
    };
  });
  const rejected = list.filter((s: any) => s.status === "rejected").map((s: any) => s.month);
  const months = [...new Set([...open, ...rejected])].sort().reverse()
    .filter((m) => { const s = list.find((x: any) => x.month === m); return !s || s.editable; });
  return json({ store: { code: st.code, name: st.name }, months: months.map((m) => ({ month: m, deadline: deadlineOf(m) })), submissions: list });
}

async function storeSubmit(form: FormData) {
  const st = await storeByToken(form.get("token"));
  if (!st) return fail("링크가 올바르지 않습니다. 본사에 문의해 주세요.", 403);
  const month = String(form.get("month") ?? "");
  const qty = Number(form.get("qty"));
  const amount = Number(form.get("amount"));
  const memo = String(form.get("memo") ?? "").slice(0, 500);
  const agree = form.get("agree") === "true";
  let keep: string[] = [];
  try { keep = JSON.parse(String(form.get("keep") ?? "[]")); } catch { /* ignore */ }
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);

  if (!validMonth(month)) return fail("정산 월을 선택해 주세요.");
  if (!Number.isInteger(qty) || qty < 0 || qty > 100000) return fail("택배 수량을 숫자로 입력해 주세요.");
  if (!Number.isInteger(amount) || amount < 0 || amount > 100000000) return fail("택배비 합계를 숫자로 입력해 주세요.");
  if (!agree) return fail("안내 사항 확인란에 체크해 주세요.");
  if (files.length > 20) return fail("사진은 한 번에 20장까지 올릴 수 있습니다.");
  for (const f of files) {
    if (f.size > 10 * 1024 * 1024) return fail("사진 한 장의 크기가 10MB를 넘습니다.");
    if (!(f.type.startsWith("image/") || f.type === "application/pdf")) return fail("사진 또는 PDF만 올릴 수 있습니다.");
  }

  const prev = (await sql`select id, status from courier.submissions where store_id = ${st.id} and month = ${month + "-01"}`)[0];
  if (prev?.status === "confirmed") return fail("본사 확인이 끝난 내역은 수정할 수 없습니다.");
  if (!isOpen(month) && prev?.status !== "rejected") return fail(`${month} 분은 마감(${deadlineOf(month)})되어 수정할 수 없습니다.`);

  const existing = prev ? await sql`select id, path from courier.photos where submission_id = ${prev.id}` : [];
  const kept = existing.filter((p: any) => keep.includes(p.id));
  if (kept.length + files.length === 0) return fail("증빙 사진을 1장 이상 첨부해 주세요.");

  // 사진 업로드
  const uploaded: string[] = [];
  for (const f of files) {
    const ext = f.type === "application/pdf" ? "pdf" : (f.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
    const path = `${st.code}/${month}/${crypto.randomUUID()}.${ext}`;
    const { error } = await sb.storage.from(BUCKET).upload(path, f, { contentType: f.type, upsert: false });
    if (error) {
      if (uploaded.length) await sb.storage.from(BUCKET).remove(uploaded);
      return fail("사진 업로드에 실패했습니다. 잠시 후 다시 시도해 주세요.", 500);
    }
    uploaded.push(path);
  }

  const removed = existing.filter((p: any) => !keep.includes(p.id));
  await sql.begin(async (tx: any) => {
    const r = await tx`
      insert into courier.submissions (store_id, month, qty, amount, memo, status, reject_reason)
      values (${st.id}, ${month + "-01"}, ${qty}, ${amount}, ${memo || null}, 'submitted', null)
      on conflict (store_id, month) do update set qty = excluded.qty, amount = excluded.amount, memo = excluded.memo,
        status = 'submitted', reject_reason = null, updated_at = now()
      returning id`;
    const sid = r[0].id;
    if (removed.length) await tx`delete from courier.photos where id = any(${removed.map((p: any) => p.id)}::uuid[])`;
    for (const p of uploaded) await tx`insert into courier.photos (submission_id, path) values (${sid}, ${p})`;
  });
  if (removed.length) await sb.storage.from(BUCKET).remove(removed.map((p: any) => p.path));
  return json({ ok: true, support: support(amount) });
}

// ---- 본사 ----
async function adminList(body: any) {
  const month = validMonth(body.month) ? body.month : addMonth(ym(kstNow()), -1);
  const rows = await sql`
    select st.code, st.name, st.sort_order, s.id, s.qty, s.amount::float8 as amount, s.support::float8 as support,
           s.memo, s.status, s.reject_reason, s.updated_at,
           (select count(*)::int from courier.photos p where p.submission_id = s.id) as photo_count
    from courier.stores st
    left join courier.submissions s on s.store_id = st.id and s.month = ${month + "-01"}
    where st.active order by st.sort_order`;
  return json({ month, deadline: deadlineOf(month), rows });
}
async function adminDetail(body: any) {
  if (typeof body.id !== "string") return fail("잘못된 요청입니다.");
  const photos = await photosFor([body.id]);
  const urls = await signed(photos.map((p: any) => p.path));
  return json({ photos: photos.map((p: any) => ({ id: p.id, url: urls[p.path] ?? null, pdf: p.path.endsWith(".pdf") })) });
}
async function adminUpdate(body: any) {
  const { id, status, reject_reason, qty, amount } = body;
  if (typeof id !== "string") return fail("잘못된 요청입니다.");
  if (!["submitted", "confirmed", "rejected"].includes(status)) return fail("상태 값이 올바르지 않습니다.");
  if (status === "rejected" && !String(reject_reason ?? "").trim()) return fail("반려 사유를 입력해 주세요.");
  if (!Number.isInteger(qty) || qty < 0 || !Number.isInteger(amount) || amount < 0) return fail("수량과 금액을 확인해 주세요.");
  await sql`
    update courier.submissions set status = ${status}, qty = ${qty}, amount = ${amount},
      reject_reason = ${status === "rejected" ? String(reject_reason).slice(0, 300) : null},
      confirmed_at = ${status === "confirmed" ? new Date() : null}, updated_at = now()
    where id = ${id}`;
  return json({ ok: true });
}
async function adminLinks() {
  const rows = await sql`select code, name, token from courier.stores where active order by sort_order`;
  return json({ rows });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail("Method not allowed", 405);
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      if (form.get("action") === "store_submit") return await storeSubmit(form);
      return fail("잘못된 요청입니다.");
    }
    const body = await req.json();
    switch (body.action) {
      case "store_info": return await storeInfo(body);
    }
    if (!(await isAdmin(body.admin))) return fail("본사 권한이 없습니다.", 403);
    switch (body.action) {
      case "admin_list": return await adminList(body);
      case "admin_detail": return await adminDetail(body);
      case "admin_update": return await adminUpdate(body);
      case "admin_links": return await adminLinks();
    }
    return fail("잘못된 요청입니다.");
  } catch (e) {
    console.error(e);
    return fail("처리 중 오류가 발생했습니다.", 500);
  }
});
