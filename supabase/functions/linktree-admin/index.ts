import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function jsonResponse(status: number, body: unknown, extraHeaders: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

async function readBody(req: Request) {
  const parsed = await req.json().catch(() => null);
  if (typeof parsed === "string") {
    try {
      return JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return parsed;
}

function supabaseHeaders(extra: Record<string, string> = {}) {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

async function supabaseFetch(path: string, init?: RequestInit) {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return jsonResponse(500, { error: "Supabase env not configured" });
  }

  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      ...supabaseHeaders(),
      ...(init?.headers ?? {}),
    },
  });

  return res;
}

function parseRpcBoolean(payload: unknown) {
  if (payload === true) return true;
  if (payload === false) return false;
  if (typeof payload === "string") {
    if (payload === "true") return true;
    if (payload === "false") return false;
  }
  if (Array.isArray(payload) && payload.length === 1) {
    const v = payload[0];
    if (v === true) return true;
    if (v === false) return false;
    if (typeof v === "object" && v) {
      const values = Object.values(v as Record<string, unknown>);
      if (values.includes(true)) return true;
      if (values.includes(false)) return false;
    }
  }
  if (typeof payload === "object" && payload) {
    const values = Object.values(payload as Record<string, unknown>);
    if (values.includes(true)) return true;
    if (values.includes(false)) return false;
  }
  return null;
}

async function verifyPassword(username: string, password: string) {
  const res = await supabaseFetch("/rest/v1/rpc/verify_admin_password", {
    method: "POST",
    headers: supabaseHeaders({
      "Content-Type": "application/json",
      Prefer: "params=single-object",
    }),
    body: JSON.stringify({ p_username: username, p_password: password }),
  });

  if (!res.ok) return false;
  const data = await res.json().catch(() => null);
  const parsed = parseRpcBoolean(data);
  return parsed === true;
}

function encodeStoragePath(path: string) {
  return path
    .split("/")
    .filter((p) => p.length > 0)
    .map((p) => encodeURIComponent(p))
    .join("/");
}

async function uploadToPublicBucket(bucket: string, objectPath: string, file: File) {
  const contentType = file.type && file.type.trim() ? file.type.trim() : "application/octet-stream";
  const bytes = await file.arrayBuffer();

  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${encodeStoragePath(objectPath)}`, {
    method: "POST",
    headers: supabaseHeaders({
      "Content-Type": contentType,
      "x-upsert": "true",
    }),
    body: bytes,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return { ok: false, error: txt || "Failed to upload" };
  }

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${encodeStoragePath(objectPath)}`;
  return { ok: true, url: publicUrl };
}

async function getDefaultSettingsWithLinks() {
  const settingsRes = await supabaseFetch(
    "/rest/v1/linktree_settings?slug=eq.default&select=id,profile_image_url,profile_name,profile_role,profile_bio,footer_text,is_verified,background_video_url&limit=1",
    { method: "GET" },
  );

  if (!settingsRes.ok) {
    const errorText = await settingsRes.text().catch(() => "");
    return { ok: false, error: errorText || "Failed to load settings" };
  }

  const settingsRows = (await settingsRes.json().catch(() => [])) as Array<Record<string, unknown>>;
  const settings = settingsRows[0];
  if (!settings || typeof settings.id !== "string") {
    return { ok: false, error: "Settings not found" };
  }

  const linksRes = await supabaseFetch(
    `/rest/v1/linktree_links?settings_id=eq.${encodeURIComponent(
      settings.id,
    )}&is_active=eq.true&select=order,title,subtitle,href,icon_text,icon_image_url,color&order=order.asc`,
    { method: "GET" },
  );

  if (!linksRes.ok) {
    const errorText = await linksRes.text().catch(() => "");
    return { ok: false, error: errorText || "Failed to load links" };
  }

  const linksRows = (await linksRes.json().catch(() => [])) as Array<Record<string, unknown>>;

  // Fetch Series
  const seriesRes = await supabaseFetch(
    `/rest/v1/linktree_series?settings_id=eq.${encodeURIComponent(
      settings.id,
    )}&select=id,title,description,icon,cover_url,order&order=order.asc`,
    { method: "GET" },
  );

  const seriesRows = seriesRes.ok ? ((await seriesRes.json().catch(() => [])) as Array<Record<string, unknown>>) : [];

  // Fetch Videos for all series
  const seriesWithVideos = await Promise.all(
    seriesRows.map(async (s: any) => {
      const videosRes = await supabaseFetch(
        `/rest/v1/linktree_series_videos?series_id=eq.${encodeURIComponent(
          s.id,
        )}&select=title,duration,url,thumb_url,order&order=order.asc`,
        { method: "GET" },
      );
      const videosRows = videosRes.ok ? ((await videosRes.json().catch(() => [])) as Array<Record<string, unknown>>) : [];
      return {
        id: s.id,
        title: s.title,
        description: s.description,
        icon: s.icon,
        coverUrl: s.cover_url,
        videos: videosRows.map((v: any) => ({
          title: v.title,
          duration: v.duration,
          url: v.url,
          thumbUrl: v.thumb_url,
        })),
      };
    }),
  );

  const config = {
    backgroundVideoUrl: String(settings.background_video_url ?? ""),
    profile: {
      imageUrl: String(settings.profile_image_url ?? ""),
      name: String(settings.profile_name ?? ""),
      role: String(settings.profile_role ?? ""),
      bio: String(settings.profile_bio ?? ""),
    },
    footerText: String(settings.footer_text ?? ""),
    isVerified: Boolean(settings.is_verified ?? true),
    links: linksRows.map((l) => ({
      order: Number(l.order ?? 0) || 0,
      title: String(l.title ?? ""),
      subtitle: String(l.subtitle ?? ""),
      href: String(l.href ?? "#"),
      icon: String(l.icon_text ?? "🔗"),
      iconImageUrl: String(l.icon_image_url ?? ""),
      color: String(l.color ?? "#9333ea"),
    })),
    series: seriesWithVideos,
  };

  return { ok: true, config, settingsId: settings.id };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/linktree-admin/, "") || "/";

  if (req.method === "GET" && (path === "/public" || path === "/")) {
    const data = await getDefaultSettingsWithLinks();
    if (!data.ok) return jsonResponse(500, { error: data.error });
    return jsonResponse(200, { config: data.config });
  }

  if (req.method === "POST" && path === "/admin/verify") {
    const body = await readBody(req);
    const username = String(body?.username ?? "").trim();
    const password = String(body?.password ?? "");

    if (!username || !password) return jsonResponse(400, { ok: false });

    const ok = await verifyPassword(username, password);
    return jsonResponse(200, { ok });
  }

  if (req.method === "POST" && path === "/admin/upload-background") {
    const form = await req.formData().catch(() => null);
    if (!form) return jsonResponse(400, { error: "Invalid form" });

    const username = String(form.get("username") ?? "").trim();
    const password = String(form.get("password") ?? "");

    if (!username || !password) return jsonResponse(401, { error: "Unauthorized" });
    const ok = await verifyPassword(username, password);
    if (!ok) return jsonResponse(401, { error: "Unauthorized" });

    const file = form.get("file");
    if (!(file instanceof File)) return jsonResponse(400, { error: "Missing file" });

    const maxBytes = 25 * 1024 * 1024;
    if (file.size > maxBytes) return jsonResponse(400, { error: "Vídeo muito grande (máx 25MB)" });

    const mime = String(file.type ?? "");
    if (!mime.startsWith("video/")) return jsonResponse(400, { error: "Arquivo precisa ser vídeo" });

    const ext = file.name && file.name.includes(".") ? file.name.split(".").pop() : "";
    const safeExt = typeof ext === "string" && ext.length <= 8 ? ext.replaceAll(/[^a-zA-Z0-9]/g, "") : "";
    const finalExt = safeExt ? `.${safeExt}` : mime === "video/webm" ? ".webm" : ".mp4";

    const objectPath = `backgrounds/default-${Date.now()}${finalExt}`;
    const uploaded = await uploadToPublicBucket("linktree-assets", objectPath, file);
    if (!uploaded.ok) return jsonResponse(500, { error: uploaded.error });

    return jsonResponse(200, { url: uploaded.url });
  }

  if (req.method === "POST" && path === "/admin/get") {
    const body = await readBody(req);
    const username = String(body?.username ?? "").trim();
    const password = String(body?.password ?? "");

    if (!username || !password) return jsonResponse(401, { error: "Unauthorized" });
    const ok = await verifyPassword(username, password);
    if (!ok) return jsonResponse(401, { error: "Unauthorized" });

    const data = await getDefaultSettingsWithLinks();
    if (!data.ok) return jsonResponse(500, { error: data.error });
    return jsonResponse(200, { config: data.config });
  }

  if (req.method === "POST" && path === "/admin/save") {
    const body = await readBody(req);
    const username = String(body?.username ?? "").trim();
    const password = String(body?.password ?? "");

    if (!username || !password) return jsonResponse(401, { error: "Unauthorized" });
    const ok = await verifyPassword(username, password);
    if (!ok) return jsonResponse(401, { error: "Unauthorized" });

    const config = body?.config as any;
    const profile = config?.profile ?? {};
    const links = Array.isArray(config?.links) ? config.links : [];
    const series = Array.isArray(config?.series) ? config.series : [];

    if (links.length > 60) return jsonResponse(400, { error: "Too many links" });

    const upsertSettingsRes = await supabaseFetch("/rest/v1/linktree_settings?on_conflict=slug", {
      method: "POST",
      headers: {
        ...supabaseHeaders({ "Content-Type": "application/json" }),
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify({
        slug: "default",
        profile_image_url: String(profile.imageUrl ?? ""),
        profile_name: String(profile.name ?? ""),
        profile_role: String(profile.role ?? ""),
        profile_bio: String(profile.bio ?? ""),
        footer_text: String(config?.footerText ?? ""),
        is_verified: Boolean(config?.isVerified ?? true),
        background_video_url: String(config?.backgroundVideoUrl ?? ""),
      }),
    });

    if (!upsertSettingsRes.ok) {
      const errorText = await upsertSettingsRes.text().catch(() => "");
      return jsonResponse(500, { error: errorText || "Failed to save settings" });
    }

    const settingsRows = (await upsertSettingsRes.json().catch(() => [])) as Array<Record<string, unknown>>;
    const settingsId = String(settingsRows[0]?.id ?? "");
    if (!settingsId) return jsonResponse(500, { error: "Missing settings id" });

    // Clear and Save Links
    const deleteLinksRes = await supabaseFetch(`/rest/v1/linktree_links?settings_id=eq.${encodeURIComponent(settingsId)}`, {
      method: "DELETE",
    });

    if (!deleteLinksRes.ok) {
      const errorText = await deleteLinksRes.text().catch(() => "");
      return jsonResponse(500, { error: errorText || "Failed to clear links" });
    }

    if (links.length > 0) {
      const linksPayload = links.map((l: any, index: number) => ({
        settings_id: settingsId,
        order: Number.parseInt(String(l.order ?? index + 1), 10) || index + 1,
        title: String(l.title ?? ""),
        subtitle: String(l.subtitle ?? ""),
        href: String(l.href ?? "#"),
        icon_text: String(l.icon ?? "🔗"),
        icon_image_url: String(l.iconImageUrl ?? ""),
        color: String(l.color ?? "#9333ea"),
        is_active: true,
      }));

      const insertLinksRes = await supabaseFetch("/rest/v1/linktree_links", {
        method: "POST",
        headers: {
          ...supabaseHeaders({ "Content-Type": "application/json" }),
          Prefer: "return=minimal",
        },
        body: JSON.stringify(linksPayload),
      });

      if (!insertLinksRes.ok) {
        const errorText = await insertLinksRes.text().catch(() => "");
        return jsonResponse(500, { error: errorText || "Failed to save links" });
      }
    }

    // Save Series and Videos
    // First, clear existing series (which should cascade delete videos if configured, or we delete them manually)
    // Actually, let's delete videos first, then series.
    const allSeriesRes = await supabaseFetch(`/rest/v1/linktree_series?settings_id=eq.${encodeURIComponent(settingsId)}&select=id`, {
      method: "GET",
    });
    const existingSeries = (await allSeriesRes.json().catch(() => [])) as Array<{ id: string }>;
    
    if (existingSeries.length > 0) {
      const seriesIds = existingSeries.map(s => s.id);
      await supabaseFetch(`/rest/v1/linktree_series_videos?series_id=in.(${seriesIds.map(id => `"${id}"`).join(",")})`, {
        method: "DELETE",
      });
      await supabaseFetch(`/rest/v1/linktree_series?settings_id=eq.${encodeURIComponent(settingsId)}`, {
        method: "DELETE",
      });
    }

    for (let i = 0; i < series.length; i++) {
      const s = series[i];
      const insertSerieRes = await supabaseFetch("/rest/v1/linktree_series", {
        method: "POST",
        headers: {
          ...supabaseHeaders({ "Content-Type": "application/json" }),
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          settings_id: settingsId,
          title: String(s.title ?? ""),
          description: String(s.description ?? ""),
          icon: String(s.icon ?? "📺"),
          cover_url: String(s.coverUrl ?? ""),
          order: i + 1,
        }),
      });

      if (insertSerieRes.ok) {
        const serieRow = (await insertSerieRes.json().catch(() => []))[0];
        if (serieRow && serieRow.id && Array.isArray(s.videos) && s.videos.length > 0) {
          const videosPayload = s.videos.map((v: any, vIdx: number) => ({
            series_id: serieRow.id,
            title: String(v.title ?? ""),
            duration: String(v.duration ?? ""),
            url: String(v.url ?? "#"),
            thumb_url: String(v.thumbUrl ?? ""),
            order: vIdx + 1,
          }));

          await supabaseFetch("/rest/v1/linktree_series_videos", {
            method: "POST",
            headers: {
              ...supabaseHeaders({ "Content-Type": "application/json" }),
              Prefer: "return=minimal",
            },
            body: JSON.stringify(videosPayload),
          });
        }
      }
    }

    return jsonResponse(200, { ok: true });
  }

  return jsonResponse(404, { error: "Not found" });
});
