# tdarr-install

Converting a home Plex library to HEVC (H.265) with [Tdarr](https://tdarr.io). The NAS stores the media and runs the Tdarr server. A Windows desktop does the encoding on its GPU. Converted files replace the originals in place, so Plex, Sonarr and Radarr keep working without reimporting anything.

The full specification and decision log is [tdarr.md](tdarr.md). This page is the overview.

## Results so far

The Movies library (791 movies) has been running since 2026-10-17. As of 2026-10-18, 167 movies were finished:

| Outcome | Movies |
|---|---|
| Converted and replaced | 103 |
| Encoded, but kept the original (the HEVC version was larger) | 30 |
| Skipped (already HEVC, or already converted) | 34 |

The 103 replaced movies went from 351.3 GB to 179.3 GB, a 49% reduction. An encode takes about 7 minutes on average, and the run averages about 10 movies an hour. The TV library (56 shows, 773 episodes) hasn't been started yet.

## Hardware

- **Bandersnatch**: QNAP TS-451 NAS, Intel Celeron (Bay Trail), 16 GB RAM, QTS 5.2, Container Station (Docker). It holds the media (about 2.4 TiB in scope) and runs Plex and the *arr stack. Its CPU is far too slow to encode.
- **Straylight**: Windows 11 desktop, Ryzen 7 5700X, 64 GB RAM, RTX 4070 SUPER and RTX 2070 SUPER. Encoding uses only the 4070 SUPER's NVENC encoder. The 2070 SUPER is kept free for other work.
- Gigabit Ethernet between them.

### Why the desktop does the encoding

The NAS's Bay Trail Celeron can't encode HEVC at any useful speed, but it can store files and serve them. The 4070 SUPER's hardware encoder does the work instead. In the baseline test, a 116-minute 1080p Blu-ray encoded at 247 fps, about 10 times real time, using 98% of the encoder and almost no CPU. Tdarr divides the work this way by design: the server keeps the library database and the queue, and any number of nodes on other machines do the processing. The files never move off the NAS. The node reads each source over SMB, encodes it locally, and writes the result back to the same folder.

## Architecture

```
Bandersnatch (NAS)                              Straylight (desktop)
+------------------------------+                +-------------------------------+
| Tdarr server (Docker)        |  port 8266     | Tdarr node (native Windows)   |
|   web UI :8265               | <------------> |   ffmpeg hevc_nvenc           |
|   library database           |                |   pinned to RTX 4070 SUPER    |
|                              |                |                               |
| /share/.../Video  (media)    |  SMB           | //bandersnatch/Video          |
|   mounted at /data           | <------------> |   reads source, writes result |
|                              |                |                               |
| Plex, Sonarr, Radarr         |                | feeder.js (queues one file    |
|   see the same files         |                |   at a time via the API)      |
+------------------------------+                +-------------------------------+
```

- The node is a *mapped* node: it reads and writes the media directly over SMB, using path translators (`/data` on the server is `//bandersnatch/Video` on the node). Unmapped nodes need Tdarr Pro for files over 10 MB.
- The GPU is pinned by UUID through `CUDA_VISIBLE_DEVICES` in [node/start-node.cmd](node/start-node.cmd). `nvidia-smi` and CUDA number the two cards differently, so an index isn't reliable.
- The node runs from Task Scheduler at startup, at priority 4. At the default priority 7, SMB reads dropped from about 65 MB/s to 5 MB/s.

### Ports and paths

| What | Where |
|---|---|
| Tdarr web UI | `http://bandersnatch:8265` |
| Tdarr server (nodes connect here) | `bandersnatch:8266` |
| Server compose file | [server/docker-compose.yml](server/docker-compose.yml), deployed to `/share/CACHEDEV1_DATA/Container/tdarr` |
| Server API key | `.env` next to the compose file (see [server/.env.example](server/.env.example)); not committed |
| Media on the NAS | `/share/CACHEDEV1_DATA/Video`, mounted at `/data`, the same path Sonarr and Radarr use |
| Transcode cache | `Video/tdarr-cache`, mounted at `/temp` |
| Node install | `D:\Tdarr` on Straylight |

## The flow

The whole decision tree is one Tdarr Flow: an Input File plugin followed by a Custom JS Function, which holds [flow/hevc-convert.js](flow/hevc-convert.js). [flow/build-flow.ps1](flow/build-flow.ps1) embeds the script into [flow/hevc-flow.json](flow/hevc-flow.json), which is then imported into Tdarr. The script makes these decisions, in this order:

1. **Never encode a file twice.** Every encode gets a global tag, `HEVC_PROJECT=cq26`. A kept `.mkv` gets `HEVC_PROJECT=kept cq26`, written in place with mkvpropedit. Any file with that tag, or with `hevc_nvenc` in its video encoder tag, is skipped.
2. **4K** (wider than 3000 px or taller than 1200 px) is downscaled to 1080p and encoded to 10-bit HEVC, with its HDR metadata carried through. This applies even when the source is already HEVC. Dolby Vision profile 8 is converted to its HDR10 base layer. Profile 5 is skipped, because it has no HDR10 fallback.
3. **HDR or Dolby Vision below 4K** is skipped.
4. **HEVC or AV1 at 2 GB or smaller** is skipped. Larger HEVC and AV1 files are re-encoded.
5. **Everything else** is encoded with `hevc_nvenc -preset p7 -tune hq -rc vbr -cq 26`, with spatial and temporal AQ. Interlaced sources are deinterlaced first.
6. **Audio** is copied unchanged. Subtitles are copied where MKV supports them and converted where it doesn't (MP4 `mov_text` to SRT). External `.srt` and `.idx`/`.sub` files whose names match the video are embedded.
7. **Default tracks**: the first English non-commentary audio track becomes the default. So does the first full English subtitle track, or the forced one if there's no full track.
8. **Replace only if smaller.** The output is always `.mkv` and keeps the original base name. When it's smaller, the original is renamed `*.old` (for example `Movie.mp4.old`), and the new file takes its place. Plex, Sonarr and Radarr ignore `.old` files. The originals are kept until a purge is approved. When the encode is larger, the original stays.

Every file handled, skipped ones included, gets a row in a local CSV log. It records the path, codec, resolution, sizes, bytes saved, CQ, encode time and outcome.

## The feeder

Tdarr normally queues a whole library at once and works through it in its own order. [node/feeder.js](node/feeder.js) feeds files one at a time instead, in alphabetical order, so progress is predictable and easy to stop:

1. Scan the library in full with "Process library" off.
2. `node feeder.js --library movies --park` sets every waiting record to "Not required", so nothing runs when processing is turned on.
3. Turn "Process library" on.
4. `node feeder.js --library movies [--count N]` sets one record to "Queued", waits for it to finish, and then queues the next. It stops after `N` files, or when nothing is left.
5. `node feeder.js --library movies --status` shows progress.

The feeder never scans. That's because a single-folder scan in Tdarr removes the records of every file outside that folder (tested 2026-10-17). The feeder reads the API key from `node/.env`, which isn't committed.

## How to

**Change the quality.** Edit `const CQ = 26;` near the top of `flow/hevc-convert.js`. Lower numbers mean better quality and bigger files. Rebuild the flow with `pwsh flow/build-flow.ps1` (PowerShell 7 is required, because 5.1 can't write UTF-8 without a BOM), then import `hevc-flow.json` into Tdarr. The marker tag records the CQ used, but a file that's already been converted is still skipped after a CQ change.

**Pause everything.**
- Stop the feeder process. The file in progress finishes, and nothing new is queued.
- To stop the current encode too, pause the Straylight node in the Tdarr web UI.
- To stop all of it, stop the `Tdarr Node` scheduled task, or `docker stop tdarr` on the NAS.

**Add a library.** Create it in the Tdarr web UI. Point it at a folder under `/data`, exclude `.@__thumb` folders (QNAP thumbnail caches), attach the `hevc_project` flow, and leave "Process library" off. Then follow the feeder steps above with `--library <library id>`.

## Not done yet

- A 10 PM to 6 AM schedule for the node.
- The TV Shows library.
- Purging the `.old` originals.
- The NAS restarts itself at 1 AM every Saturday and Sunday. The feeder exits when it loses the server, so it has to be restarted by hand after each restart.

## Repository layout

```
README.md               this page
tdarr.md                specification and decision log
flow/hevc-convert.js    the flow's decision and encode logic
flow/build-flow.ps1     embeds hevc-convert.js into hevc-flow.json
flow/hevc-flow.json     importable Tdarr flow
node/feeder.js          one-at-a-time queue feeder
node/start-node.cmd     starts the node pinned to the 4070 SUPER
node/mapping-test.ps1   SMB path, speed and replace-sequence test
server/                 Docker compose file and .env example for the server
```
