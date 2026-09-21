// TEMPORARY PROBE — not part of the product.
//
// Douyin's Argus gate currently passes from a residential connection (Node 18,
// Node 24 and curl all succeed) but refuses our Lambda functions. Netlify Edge
// Functions run on Deno from a different egress than the AWS Lambda functions,
// so this measures whether that egress is treated differently. If it is, the
// Douyin resolve can move here and stay free; if not, this file gets deleted.
export default async function handler(): Promise<Response> {
  const UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const ID = "7631138806736964870";

  const head = await fetch(`https://www.douyin.com/video/${ID}`, {
    method: "HEAD",
    redirect: "manual",
    headers: { "User-Agent": UA },
  });
  const jar: Record<string, string> = {};
  for (const c of head.headers.getSetCookie?.() ?? []) {
    const m = /^\s*([^=]+)=([^;]*)/.exec(c);
    if (m) jar[m[1].trim()] = m[2];
  }
  if (!jar.ttwid || !jar.UIFID_TEMP) {
    return Response.json({ stage: "mint", head: head.status, names: Object.keys(jar) });
  }

  const qs = new URLSearchParams({
    device_platform: "webapp", aid: "6383", aweme_id: ID,
    version_code: "190500", version_name: "19.5.0",
  }).toString();
  const cookie = `ttwid=${jar.ttwid}; UIFID=${jar.UIFID_TEMP}; UIFID_TEMP=${jar.UIFID_TEMP}`;

  const codes: number[] = [];
  let ok = 0;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`https://www.douyin.com/aweme/v1/web/aweme/detail/?${qs}`, {
      headers: {
        "User-Agent": UA, Accept: "application/json",
        Referer: `https://www.douyin.com/video/${ID}`, Cookie: cookie,
      },
    });
    const t = await r.text();
    codes.push(r.status);
    if (r.status === 200 && t.length > 500) ok++;
  }
  return Response.json({ stage: "detail", ok, of: 4, codes, runtime: "edge/deno" });
}
