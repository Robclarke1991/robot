// api/spotify.js — lets Moby drive Spotify.
//
// The page can't play music itself (Spotify's browser player doesn't work on
// phones), so instead the Spotify app runs on the Pixel and this controls it
// over Spotify Connect — exactly like picking a speaker from your phone.
//
// ONE-TIME SETUP
//   1. developer.spotify.com/dashboard -> Create app
//      Redirect URI: https://YOUR-URL.vercel.app/api/spotify?action=callback
//      (must match exactly, including https and no trailing slash)
//      Tick "Web API".
//   2. In Vercel add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET, redeploy.
//   3. Visit https://YOUR-URL.vercel.app/api/spotify?action=login in a browser,
//      log in, approve. The page that comes back shows a refresh token.
//   4. Add it as SPOTIFY_REFRESH_TOKEN in Vercel, redeploy. Done forever.
//
// Playback needs Spotify Premium and a device that has been active recently —
// so open the Spotify app on the Pixel and play something once.

export const config = { maxDuration: 20 };

const SCOPES = [
  "user-modify-playback-state",
  "user-read-playback-state"
].join(" ");

function redirectUri(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return "https://" + host + "/api/spotify?action=callback";
}

async function accessToken() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  const refresh = process.env.SPOTIFY_REFRESH_TOKEN;
  if (!id || !secret) throw new Error("Spotify client id/secret not set");
  if (!refresh) throw new Error("Not linked to Spotify yet — run the login step");

  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Basic " + Buffer.from(id + ":" + secret).toString("base64")
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error_description || "Spotify refused the refresh token");
  return data.access_token;
}

async function sp(token, path, method, body) {
  const r = await fetch("https://api.spotify.com/v1" + path, {
    method: method || "GET",
    headers: {
      authorization: "Bearer " + token,
      ...(body ? { "content-type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (r.status === 204) return null;              // most playback calls
  const text = await r.text();
  if (!text) return null;
  const data = JSON.parse(text);
  if (!r.ok) throw new Error((data.error && data.error.message) || "Spotify error");
  return data;
}

// Playback calls need a device. Prefer one already playing, else the phone,
// else whatever is there.
async function pickDevice(token) {
  const list = await sp(token, "/me/player/devices");
  const ds = (list && list.devices) || [];
  if (!ds.length) return null;
  return (ds.find(d => d.is_active) ||
          ds.find(d => d.type === "Smartphone") ||
          ds[0]).id;
}

export default async function handler(req, res) {
  const action = req.query.action;

  // ---- step 1: send the user to Spotify to approve ----
  if (action === "login") {
    const id = process.env.SPOTIFY_CLIENT_ID;
    if (!id) return res.status(500).send("SPOTIFY_CLIENT_ID is not set in Vercel.");
    const url = "https://accounts.spotify.com/authorize?" + new URLSearchParams({
      client_id: id,
      response_type: "code",
      redirect_uri: redirectUri(req),
      scope: SCOPES
    });
    res.writeHead(302, { Location: url });
    return res.end();
  }

  // ---- step 2: swap the code for a refresh token and show it ----
  if (action === "callback") {
    const code = req.query.code;
    if (!code) return res.status(400).send("No code returned from Spotify.");
    const id = process.env.SPOTIFY_CLIENT_ID;
    const secret = process.env.SPOTIFY_CLIENT_SECRET;
    const r = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Basic " + Buffer.from(id + ":" + secret).toString("base64")
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(req)
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(400).send("Spotify said: " + JSON.stringify(data));
    res.setHeader("content-type", "text/html");
    return res.status(200).send(
      "<body style='font-family:system-ui;padding:2rem;line-height:1.6'>" +
      "<h2>Linked.</h2><p>Add this to Vercel as <b>SPOTIFY_REFRESH_TOKEN</b>, " +
      "then redeploy:</p><p style='word-break:break-all;background:#eee;" +
      "padding:1rem;border-radius:.5rem'><code>" + data.refresh_token +
      "</code></p><p>Then close this page. You won't need it again.</p></body>");
  }

  // ---- everything else: playback control ----
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const allowed = process.env.ALLOWED_ORIGIN;
  const origin = req.headers.origin;
  if (allowed && origin && origin !== allowed) {
    return res.status(403).json({ error: "Not allowed from this origin" });
  }

  const { doWhat, query, volume } = req.body || {};

  try {
    const token = await accessToken();

    if (doWhat === "pause")  { await sp(token, "/me/player/pause", "PUT");     return res.json({ ok: true }); }
    if (doWhat === "resume") { await sp(token, "/me/player/play", "PUT");      return res.json({ ok: true }); }
    if (doWhat === "next")   { await sp(token, "/me/player/next", "POST");     return res.json({ ok: true }); }

    if (doWhat === "volume") {
      const v = Math.max(0, Math.min(100, Number(volume) || 0));
      await sp(token, "/me/player/volume?volume_percent=" + v, "PUT");
      return res.json({ ok: true, volume: v });
    }

    if (doWhat === "play") {
      if (!query) return res.status(400).json({ error: "Nothing to play" });
      const found = await sp(token,
        "/search?type=track&limit=1&q=" + encodeURIComponent(query));
      const track = found && found.tracks && found.tracks.items && found.tracks.items[0];
      if (!track) return res.status(404).json({ error: "Couldn't find that song" });

      const device = await pickDevice(token);
      if (!device) {
        return res.status(409).json({
          error: "No Spotify device is awake. Open Spotify on the phone and play something once."
        });
      }
      await sp(token, "/me/player/play?device_id=" + device, "PUT", { uris: [track.uri] });
      return res.json({
        ok: true,
        title: track.name,
        artist: (track.artists[0] || {}).name || ""
      });
    }

    return res.status(400).json({ error: "Unknown action" });

  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
