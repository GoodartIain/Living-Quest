# Deploying Living Quest

## On one computer (testing)

```sh
cp .env.example .env        # set LIVEKIT_API_KEY and a 32+ character LIVEKIT_API_SECRET
docker compose up
```

Open http://localhost:3000. Voice and video work for browsers on the same computer, because browsers allow microphones and cameras on `localhost`.

Without Docker: run PostgreSQL, download `livekit-server` (v1.13.11) from https://github.com/livekit/livekit/releases and run
`livekit-server --dev --bind 127.0.0.1 --node-ip 127.0.0.1` (dev keys `devkey` / `secret`), then
`DATABASE_URL=… LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret npm start`.

## For a group over the internet

Voice and video need three things a plain `docker compose up` does not give you:

1. **HTTPS for the app and WSS for LiveKit.** Browsers refuse microphone and camera on non-secure pages. Put a TLS reverse proxy (for example Caddy or nginx with Let's Encrypt) in front of both: `https://quest.example.com` → app port 3000, `wss://voice.example.com` → LiveKit port 7880. Set `LIVEKIT_PUBLIC_URL=wss://voice.example.com` in `.env`.
2. **LiveKit's media ports open:** TCP 7881 and UDP 50000–50100 on the server's firewall, and `LIVEKIT_NODE_IP` set to the server's public IP so browsers are told where to send media.
3. **Strong keys** in `.env` (never the dev `devkey`/`secret`).

Players behind strict corporate firewalls may need TURN; LiveKit has a built-in TURN server (see the LiveKit self-hosting guide, "TURN") that can be enabled in `LIVEKIT_CONFIG`.

Rough sizing: a GM and six players with camera on is comfortably handled by a small VPS (2 vCPU); LiveKit forwards streams, it does not mix or transcode them.
