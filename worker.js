// RY289 Tracker — Worker + KV central store
const KEYS = ["staff","pos","perm","pw","acctfix","del","fu","fust","vipbn"];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- ประตูรหัสผ่านชั้นนอก (กันทั้งเว็บ + ข้อมูล PII ก่อนเสิร์ฟ) ---
    // ทำงานเฉพาะเมื่อมีการตั้ง secret ชื่อ GATE_PASS ใน Cloudflare เท่านั้น
    // ไม่ได้ตั้ง = ปล่อยผ่าน (เว็บทำงานปกติ) เพื่อกันล็อกตัวเองตอน deploy
    const gatePass = (env.GATE_PASS || "").trim();
    if (gatePass) {
      const gateUser = (env.GATE_USER || "team").trim();
      const auth = request.headers.get("Authorization") || "";
      let ok = false;
      if (auth.startsWith("Basic ")) {
        try {
          const dec = atob(auth.slice(6));
          const i = dec.indexOf(":");
          const u = dec.slice(0, i);
          const p = dec.slice(i + 1);
          // เทียบแบบ constant-time พอประมาณ
          const a = gateUser + ":" + gatePass;
          const b = u + ":" + p;
          let diff = a.length ^ b.length;
          for (let k = 0; k < a.length; k++) diff |= a.charCodeAt(k) ^ (b.charCodeAt(k) || 0);
          ok = diff === 0;
        } catch (e) {}
      }
      if (!ok) {
        return new Response("ต้องยืนยันตัวตนก่อนเข้าใช้งาน", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Basic realm="RH Tracker", charset="UTF-8"',
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }
    }

    if (url.pathname.startsWith("/api/")) {
      // GET /api/state -> ทุก key รวดเดียว
      if (url.pathname === "/api/state" && request.method === "GET") {
        const out = {};
        await Promise.all(KEYS.map(async (k) => {
          const v = await env.DB.get("ry289_" + k);
          if (v !== null) out[k] = v;
        }));
        return json(out);
      }
      // helper: อ่าน token/chat จาก env ก่อน ถ้าไม่มีค่อยอ่านจาก KV (ตั้งผ่านหน้าเว็บ)
      const tgCfg = async () => {
        let token = env.TELEGRAM_TOKEN || "", chat = env.TELEGRAM_CHAT || "";
        if (!token || !chat) {
          try { const c = await env.DB.get("ry289_tgcfg"); if (c) { const o = JSON.parse(c); token = token || o.token || ""; chat = chat || o.chat || ""; } } catch (e) {}
        }
        return { token, chat };
      };

      // POST /api/tgset -> ตั้งค่า Token+Chat จากหน้าเว็บ (เก็บใน KV, ไม่เปิดอ่านคืน)
      if (url.pathname === "/api/tgset" && request.method === "POST") {
        try {
          const b = await request.json();
          await env.DB.put("ry289_tgcfg", JSON.stringify({ token: String(b.token || "").trim(), chat: String(b.chat || "").trim() }));
        } catch (e) {}
        return json({ ok: true });
      }

      // GET /api/tgstatus -> บอกแค่สถานะ (ไม่คืน token เต็ม)
      if (url.pathname === "/api/tgstatus" && request.method === "GET") {
        const envSet = !!(env.TELEGRAM_TOKEN && env.TELEGRAM_CHAT);
        let configured = envSet, chat = envSet ? "(ตั้งใน Cloudflare)" : "", tail = "";
        try { const c = await env.DB.get("ry289_tgcfg"); if (c) { const o = JSON.parse(c); if (o.token && o.chat) { configured = true; if (!envSet) { chat = o.chat || ""; tail = "..." + String(o.token).slice(-4); } } } } catch (e) {}
        return json({ configured, chat, tail });
      }

      // POST /api/notify -> ส่งข้อความเข้า Telegram (คืนผลจริงเพื่อดีบัก)
      if (url.pathname === "/api/notify" && request.method === "POST") {
        try {
          const ev = await request.json();
          const { token, chat } = await tgCfg();
          if (!token || !chat) return json({ ok: false, reason: "ยังไม่ได้ตั้งค่า Token/Chat ID" });
          if (!ev || !ev.text) return json({ ok: false, reason: "ไม่มีข้อความ" });
          const txt = String(ev.text).slice(0, 3500);
          const resp = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chat, text: txt, parse_mode: "HTML", disable_web_page_preview: true }),
          });
          const rj = await resp.json().catch(() => ({}));
          return json({ ok: rj.ok === true, code: rj.error_code || 0, description: rj.description || "" });
        } catch (e) { return json({ ok: false, error: String(e) }); }
      }

      // POST /api/notifyPhoto -> ส่งรูป (แคปตาราง) + caption เข้า Telegram
      if (url.pathname === "/api/notifyPhoto" && request.method === "POST") {
        try {
          const ev = await request.json();
          const { token, chat } = await tgCfg();
          if (!token || !chat) return json({ ok: false, reason: "ยังไม่ได้ตั้งค่า Token/Chat ID" });
          let du = String(ev.photo || "");
          const ci = du.indexOf(",");
          const b64 = ci >= 0 ? du.slice(ci + 1) : du;
          if (!b64) return json({ ok: false, reason: "ไม่มีรูป" });
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const form = new FormData();
          form.append("chat_id", chat);
          if (ev.caption) { form.append("caption", String(ev.caption).slice(0, 1024)); form.append("parse_mode", "HTML"); }
          form.append("photo", new Blob([bytes], { type: "image/png" }), "report.png");
          const resp = await fetch("https://api.telegram.org/bot" + token + "/sendPhoto", { method: "POST", body: form });
          const rj = await resp.json().catch(() => ({}));
          return json({ ok: rj.ok === true, code: rj.error_code || 0, description: rj.description || "" });
        } catch (e) { return json({ ok: false, error: String(e) }); }
      }
      const key = url.pathname.split("/")[2];
      const BIGKEYS = ["rydep", "rydates", "rydaily", "tsnap", "piv", "follow", "dbbase"]; // ข้อมูลยอด RUAYHENG + snapshot รายวัน (ไม่รวมใน /api/state)
      if (KEYS.includes(key) || BIGKEYS.includes(key)) {
        if (request.method === "PUT" || request.method === "POST") {
          const body = await request.text();
          const cap = BIGKEYS.includes(key) ? 20_000_000 : 4_000_000;
          if (body.length > cap) return json({ error: "payload too large" }, 413);
          await env.DB.put("ry289_" + key, body);
          return json({ ok: true });
        }
        if (request.method === "GET") {
          const v = await env.DB.get("ry289_" + key);
          return new Response(v ?? "null", { headers: { "content-type": "application/json" } });
        }
      }
      return json({ error: "bad request" }, 400);
    }

    // ที่เหลือ: เสิร์ฟไฟล์เว็บ + SPA fallback (route ที่ไม่ใช่ไฟล์ -> index.html)
    const assetRes = await env.ASSETS.fetch(request);
    if (assetRes.status === 404 && request.method === "GET" && !url.pathname.slice(1).includes(".")) {
      return env.ASSETS.fetch(new Request(new URL("/", url.origin), request));
    }
    return assetRes;
  },
};
