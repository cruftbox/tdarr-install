# tdarr-install

Converting a home Plex library to HEVC (H.265) with [Tdarr](https://tdarr.io). The NAS stores the media and runs the Tdarr server. A Windows desktop does the encoding on its GPU. Converted files replace the originals in place, so Plex, Sonarr and Radarr keep working without reimporting anything.

The full specification and decision log is [tdarr.md](tdarr.md). This page is the overview.

## Results

Both libraries are finished. Movies ran from 2026-10-17 to 2026-10-20; TV Shows ran on 2026-10-21 and 22. Both libraries now use folder watching, so new downloads are processed as they arrive.

| Outcome | Movies | TV episodes | Total |
|---|---|---|---|
| Converted and replaced | 493 | 273 | 766 |
| Encoded, but kept the original (the HEVC version was not smaller) | 157 | 34 | 191 |
| Skipped (already HEVC and 2 GB or smaller, or already converted) | 149 | 574 | 723 |
| Remuxed only (default tracks fixed, video copied) | 1 | 0 | 1 |
| Failed the duration check, original kept | 0 | 17 | 17 |
| **Files** | **800** | **898** | **1,698** |

| | Movies | TV Shows | Total |
|---|---|---|---|
| Replaced files, before → after | 1643.4 → 874.0 GB (47%) | 377.0 → 195.2 GB (48%) | 2020.4 → 1069.3 GB (47%) |
| Library, before → after | 2.14 → 1.37 TB | 739.5 → 557.8 GB | 2.88 → 1.93 TB |
| Space saved | 769 GB | 182 GB | 951 GB |
| Encodes / GPU hours | 651 / 80.9 h | 307 / 20.1 h | 958 / 101.0 h |
| Average encode | 7.5 min | 3.9 min | 6.3 min |

The library sizes leave out the 17 failed episodes, which are unchanged on disk. All 17 failed for one reason: a subtitle file next to the episode ran longer than the video, so embedding it made the output longer than the source and the flow's duration check refused the replacement. With one node the Movies run did 8 to 11 movies an hour; after the second node joined on 2026-10-19 it did 15 to 20. Per-file results are in [logs/transcode-log.csv](logs/transcode-log.csv).

## Hardware

- **Bandersnatch**: QNAP TS-451 NAS, Intel Celeron (Bay Trail), 16 GB RAM, QTS 5.2, Container Station (Docker). It holds the media (about 2.4 TiB in scope) and runs Plex and the *arr stack. Its CPU is far too slow to encode.
- **Straylight**: Windows 11 desktop, Ryzen 7 5700X, 64 GB RAM, RTX 4070 SUPER and RTX 2070 SUPER. Each card runs its own Tdarr node and NVENC encoder. The 2070 SUPER node was added on 2026-10-19. In a test on the same file it took 684 s, compared with 588 s on the 4070 SUPER, and the output size was within 1%.
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
- There are two nodes on Straylight, each a separate install with its own config. Each one is pinned to one card by UUID through `CUDA_VISIBLE_DEVICES`, in [node/start-node.cmd](node/start-node.cmd) and [node/start-node-2070.cmd](node/start-node-2070.cmd). The feeder runs with `--slots 2`, so each node has one file at a time. `nvidia-smi` and CUDA number the two cards differently, so an index isn't reliable.
- Each node runs from its own Task Scheduler task at startup, at priority 4. At the default priority 7, SMB reads dropped from about 65 MB/s to 5 MB/s.

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

Every file handled, skipped ones included, gets a row in [logs/transcode-log.csv](logs/transcode-log.csv). It records the path, codec, resolution, sizes, bytes saved, CQ, encode time and outcome. Rows from the test library are kept in a separate local file.

New files in the Movies and TV Shows libraries are picked up by Tdarr's folder watching and processed as they arrive. Encoding has no fixed schedule: the nodes are paused by hand during video calls and games. Originals renamed `.old` are purged by hand after each run.

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
- Pause both nodes (`Straylight` and `Straylight-2070`) in the Tdarr web UI. Nothing new starts; an encode already running finishes. If the feeder is running, stop it too.
- To stop a running encode as well, stop the `Tdarr Node` and `Tdarr Node 2070` scheduled tasks, or `docker stop tdarr` on the NAS.

**Add a library.** Create it in the Tdarr web UI. Point it at a folder under `/data`, exclude `.@__thumb` folders (QNAP thumbnail caches), attach the `hevc_project` flow, and leave "Process library" off. Then follow the feeder steps above with `--library <library id>`.

## Not done yet

- Purging the `.old` originals left by the TV Shows run.
- The 17 TV episodes that failed the duration check (2 Battlestar Galactica: Blood & Chrome webisodes, 15 Dark Matter episodes) need correct subtitle files, or a flow change, before they can be converted.

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
