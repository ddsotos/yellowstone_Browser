# Yellowstone Browser Online Play Quickstart

This runs the current browser game as a local online table server. Open the same
URL in two browser windows to test two human seats. Empty seats are filled with
CPU players when the host starts the game.

## Local Two-Window Play

1. Start the online server in the background.

```powershell
.\scripts\online-start.cmd
```

2. Open two browser windows.

```text
http://localhost:9293/?online=1
```

3. Check server status when needed.

```powershell
.\scripts\online-status.cmd
```

4. Log in with different names in each window.

5. In the first window, create a game.

6. In the second window, join from the game list.

7. The host can remove joined players while the table is waiting, then start the
   game at any time. Seats not filled by humans become CPU seats.

To stop the local online server:

```powershell
.\scripts\online-stop.cmd
```

## Friend Access With Cloudflare Quick Tunnel

Keep the online server running locally, then start a Quick Tunnel in another
terminal.

If `cloudflared` is installed locally:

```powershell
cloudflared tunnel --url http://localhost:9293
```

If you want to run `cloudflared` through Docker:

```powershell
docker run --rm -it cloudflare/cloudflared:latest tunnel --no-autoupdate --url http://host.docker.internal:9293
```

Share the generated `https://...trycloudflare.com/?online=1` URL with friends.
The URL changes every time the tunnel is restarted.

## Notes

- Initial version allows one active game at a time.
- Names are locked while the previous connection is active. A disconnected name
  is released after 5 seconds.
- Game state is saved on the local server in `local-data/online-state.json`.
- Current CPU fallback uses the existing heuristic CPU. Strong server-side AI CPU
  is intentionally left behind the same API boundary for the next step.
