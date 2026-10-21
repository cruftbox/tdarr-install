# Project: Tdarr transcoding with GPU offload to Straylight

## Goal

Shrink my Plex library by converting older codecs to HEVC. The Tdarr server runs on my NAS (Bandersnatch). The actual encoding happens on my desktop (Straylight) using the RTX 4070 Super's NVENC encoder. Results replace the originals in place so Plex, Sonarr, and Radarr keep working.

## Environment

- **Bandersnatch**: QNAP TS-451 NAS, Intel Celeron (Bay Trail, x86_64), 16 GB RAM (upgraded), QTS 5.x, Container Station (Docker). Holds all media and runs Plex. It cannot do meaningful transcoding. Plex stream transcoding on the NAS is out of scope for this project.
- **Straylight**: Windows 11, Ryzen 7 5700X, 64 GB RAM, RTX 4070 Super and RTX 2070 Super. The 2070 Super was reserved for Ollama until 2026-10-19; since then it runs a second Tdarr node. Has local NVMe storage. WSL2 Ubuntu is installed, but the Tdarr node runs natively on Windows, not in WSL.
- Gigabit LAN between the two.
- Library is mostly 1080p or below. Many files are already HEVC.
- Claude has SSH key access to Bandersnatch as `<nas-user>`. Passwordless sudo for `<nas-user>` is the rule `<nas-user> ALL=(ALL) NOPASSWD: ALL` in `/usr/etc/sudoers.d/<nas-user>` (included by the stock `/usr/etc/sudoers`). The root filesystem is a RAM disk, so the file is recreated at boot by `autorun.sh` on the flash config partition `/dev/sde6` (requires `Misc Autorun = TRUE`). The first attempt (2026-10-16) failed because the script was written to `/tmp/config`, which is a plain RAM-disk directory at runtime: `init_disk.sh mount_flash_config` mounts `/dev/sde6` at `/tmp/nasconfig_tmp`, and only the boot script (`init_nas.sh`) mounts it at `/tmp/config`. Fixed 2026-10-18: script written to `/tmp/nasconfig_tmp/autorun.sh` (mode 755, LF endings), verified present on `/dev/sde6` after unmount. Not yet proven across a reboot. To edit it: `sudo /etc/init.d/init_disk.sh mount_flash_config`, edit `/tmp/nasconfig_tmp/autorun.sh`, `sudo /etc/init.d/init_disk.sh umount_flash_config`. Docker does not need sudo.
- The *arr stack is installed and working (confirmed 2026-10-16): Sonarr 4.0.20, Radarr 6.4.4, Prowlarr, Bazarr, NZBGet, Recyclarr, linuxserver images. Compose file and `.env` are in `/share/CACHEDEV1_DATA/Video/arr-config/`. Both Sonarr and Radarr mount `/share/CACHEDEV1_DATA/Video` at `/data`; root folders are `/data/Movies` and `/data/TV Shows`. Tdarr uses the same mapping.
- Docker on Bandersnatch: `<nas-user>` can run it without sudo. The binary is `/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker`, which is not on the default SSH PATH. Use `docker compose` (v2.29.1-qnap2); standalone `docker-compose` is not installed. Ports 8265 and 8266 were free on 2026-10-16.

## GPUs on Straylight (observed 2026-10-16)

| nvidia-smi index | Card | PCI bus | UUID |
|---|---|---|---|
| 0 | RTX 2070 SUPER | 05:00.0 | GPU-cbda3789-545b-0581-8fa2-86b5c0cbfda2 |
| 1 | RTX 4070 SUPER | 0B:00.0 | GPU-3cbe5267-c72c-2d08-c4a7-e61fd8c0917e |

`nvidia-smi` numbers GPUs by PCI bus order. CUDA, which ffmpeg uses for NVENC, numbers them fastest first by default, so the 4070 Super is likely CUDA device 0 while `nvidia-smi` calls it GPU 1. Pin by UUID (`CUDA_VISIBLE_DEVICES=GPU-3cbe5267-c72c-2d08-c4a7-e61fd8c0917e`) so neither numbering scheme matters. The cards will not be moved.

## Media library

- Share `\\bandersnatch\Video` is `/share/CACHEDEV1_DATA/Video` on the NAS.
- **Movies**: `Video/Movies`, one folder per movie, one video file per folder, no subfolders.
- **TV Shows**: `Video/TV Shows`, one folder per show, episodes directly in the show folder, no season subfolders.
- `Video/DVD` and `Video/Holding` are out of scope.
- Keep this organization.
- State after cleanup on 2026-10-16: 791 movie folders, 56 TV shows with 773 episodes. Movies 1.90 TiB, TV Shows 524 GiB, total 2.41 TiB. File types: 1056 mkv, 219 mp4, 200 m4v, 89 avi, plus 8 srt and 8 idx/sub subtitle sidecars.
- Volume has 56 TB free. Disk space is not a constraint.
- Exclude `.@__thumb` folders (QNAP thumbnail caches, whose files carry video extensions) from Tdarr libraries.

## Installed (2026-10-17)

Tdarr 3.01.00, mapped node. Unmapped nodes were rejected: without Tdarr Pro they only transfer video files up to 10 MB, and "Replace Original File" must run on a mapped node anyway.

**Server** on Bandersnatch: `/share/CACHEDEV1_DATA/Container/tdarr` (compose file from `server/docker-compose.yml` in this repo, plus `.env` with `TDARR_API_KEY`, mode 600, not committed). Image `ghcr.io/haveagitgat/tdarr:3.01.00`. Web UI `http://bandersnatch:8265`, server port 8266. Mounts `/share/CACHEDEV1_DATA/Video` at `/data` (same as Sonarr and Radarr) and `Video/tdarr-cache` at `/temp`. PUID 500 / PGID 100. Auth on; the key is seeded with `seededApiKey`, which also created the `admin` web login with the key as its password. Internal node disabled. No libraries configured yet.

**Node** on Straylight: `D:\Tdarr\Tdarr_Node`, config `D:\Tdarr\configs\Tdarr_Node_Config.json`, logs `D:\Tdarr\logs`. Node name `Straylight`, type mapped, server `http://bandersnatch:8266`, `startPaused: true`. Path translators:

| Server | Node |
|---|---|
| `/data` | `//bandersnatch/Video` |
| `/temp` | `//bandersnatch/Video/tdarr-cache` |

Started by Task Scheduler task `Tdarr Node`: at startup, run whether logged on or not, as `STRAYLIGHT\<windows-user>` (password stored in the task), priority 4, no time limit, 3 restarts. The task runs `D:\Tdarr\start-node.cmd` (copy in `node/start-node.cmd`), which sets `CUDA_VISIBLE_DEVICES` to the 4070 Super UUID. Registering a startup task requires an elevated shell. The bundled ffmpeg is 7.1.4-jellyfin; `hevc_nvenc` tests as working.

**Second node** (added 2026-10-19): `Straylight-2070`, a copy of the install at `D:\Tdarr2\Tdarr_Node` with its own `D:\Tdarr2\configs` and `D:\Tdarr2\logs`, pinned to the 2070 Super UUID (`node/start-node-2070.cmd`). Worker limits on both nodes: one GPU transcode, nothing else. Test before adding it (Brave, 5.87 GB 1080p H.264): 684 s and 2.321 GB on the 2070 Super, against 588 s and 2.339 GB on the 4070 Super. Since 2026-10-21 it starts from Task Scheduler task `Tdarr Node 2070`, set up like the first node's (at startup, run whether logged on or not, priority 4, no time limit, 3 restarts), running `D:\Tdarr2\start-node.cmd`; verified by its startup log showing `av1_nvenc` not working, which is true only of the 2070. The script had failed when launched from Claude Code because that environment sets `NoDefaultCurrentDirectoryInExePath=1`, so cmd does not run `Tdarr_Node.exe` from the current folder; Task Scheduler does not set it. The feeder runs with `--slots 2`.

UNC paths must use the host name `bandersnatch` exactly: the saved Windows credential (user `<nas-user>`) is for that target, not the IP or `bandersnatch.local`.

## Mapping test (2026-10-17)

Script: `node/mapping-test.ps1`. Test folder `Video/mapping-test` (kept for the test phase, holds a copy of Murderbot S01E03).

- Read over UNC 50 to 80 MB/s; write to the cache 46 to 53 MB/s. Encode output needs about 6 MB/s.
- The replace sequence (copy to cache, rename original to `.old`, move into folder, rename to `.mkv`) passed, including names with apostrophes, ampersands, parentheses, brackets, and a 303-character path.
- Files written over SMB arrive as `<nas-user>:everyone`, mode 644, readable by the *arr containers.
- Under a non-interactive Task Scheduler logon the saved SMB credential works. At Task Scheduler's default priority 7, reads dropped to 4.9 MB/s; at priority 4 they were 64.8 MB/s.

## Replace test (2026-10-17)

Croupier (`Croupier.m4v`, H.264 720x360) encoded to `Croupier.mkv` (724.0 MB to 675.7 MB, 6.7% smaller) and swapped in with the original renamed `Croupier.m4v.old`.

- **Plex** detected the change on its own within minutes, kept the same metadata item, pointed it at the `.mkv`, and ignored the `.old` file.
- **Radarr** rescans logged the `.m4v` as deleted and rejected the `.mkv` with "[Permanent] Unable to parse file", because the folder and file names carry no year. A Radarr `ManualImport` command with the movie id imported it. File names are being changed to include the year (separate work). Until then, each replacement needs an API import.
- **Sonarr** not yet tested.
- Recyclarr concern resolved: all movies use profile "HD-1080p HEVC", which scores x265 +2000. Only 7 of 792 movies are monitored.

## Baseline test encode (2026-10-16)

Manual encode on Straylight with portable ffmpeg 8.1 (BtbN build), not Tdarr's ffmpeg.

- Source: Red 2, 1080p Blu-ray x264, 1920x800, 116 min, DTS 5.1, one SRT. 8.52 GB.
- Command: `-hwaccel cuda -hwaccel_output_format cuda -map 0 -c:v hevc_nvenc -preset p7 -tune hq -rc vbr -cq 26 -b:v 0 -spatial_aq 1 -temporal_aq 1 -rc-lookahead 32 -profile:v main -c:a copy -c:s copy`, with `CUDA_VISIBLE_DEVICES` set to the 4070 Super UUID.
- Result: 4.63 GB (46% smaller overall). Video went from about 8.3 Mb/s to 3.7 Mb/s.
- Speed: 247 fps, about 10x real time, 11 min 15 s encode.
- Transfer: NAS to Straylight over SMB at 103 MB/s (83 s for 8.52 GB).
- GPU: 4070 Super averaged 98% encoder use; 2070 Super stayed at 0%. UUID pinning works.
- Picture quality not yet reviewed.

## Open concerns

- Radarr does not auto-import replaced files whose names lack a year (see Replace test).
- GPU pinning under the task has not been seen on a live job yet.
- Bazarr manages subtitles and may add new sidecar files after conversion.

## Requirements

1. **Inspect first**: confirm Docker and compose availability on Bandersnatch, whether `docker` needs root, the media paths, and free disk space. On Straylight, pick a local NVMe path for the transcode cache.
2. **Tdarr Server** on Bandersnatch in Docker, current stable release (not beta). Mount the media library read-write at the same container path other services use. Its internal node is disabled. Runs continuously until the project ends.
3. **Tdarr Node** on Straylight as the native Windows app, current stable release, running in the background. Mapped node type with path translators (see Installed). The task is removed when the project ends.
4. **GPU pinning**: each node is pinned to one card by UUID (the 4070 Super node, and since 2026-10-19 the 2070 Super node). Verify during a live job with `nvidia-smi dmon -s u`: the `enc` column must be active only on the card whose node is encoding. Verified 2026-10-19 with each node encoding a different file.
5. **Flow logic**, built with Tdarr Flows:
   - Never encode a file twice. Every file the flow encodes gets the global tag `HEVC_PROJECT=cq26`. A kept `.mkv` (encode not smaller) gets `HEVC_PROJECT=kept cq26` in place with mkvpropedit, its other global tags preserved; kept files in other containers cannot be tagged and would be encoded again if requeued. A file with that tag, or whose video stream's `ENCODER` tag contains `hevc_nvenc` (files converted before the tag existed), is skipped before any other rule. Tested 2026-10-17 on two clips.
   - Skip files whose video is already HEVC or AV1 and that are 2 GB (2,000,000,000 bytes) or smaller. Leave them unchanged, including their container. HEVC/AV1 files larger than 2 GB are re-encoded like any other file (the HDR rule below still applies), and 4K files are handled by the 4K rule.
   - 4K files (wider than 3000 px or taller than 1200 px) of any codec are downscaled to 1080p and encoded to HEVC. Ultrawide 1080p (for example 2592x1080) is not 4K. Plex's database lists 16 such files on 2026-10-16: 5 movies, 7 episodes of The Mandalorian, 4 of Shrinking. This applies even when the 4K file is already HEVC. HDR is kept: encode 1080p HEVC 10-bit and carry the HDR metadata (color primaries, transfer, matrix, mastering display, content light level) through to the output. Verify during testing that the Tdarr ffmpeg build passes HDR metadata through NVENC.
   - Dolby Vision in 4K files: Profile 8 is converted (the Dolby Vision layer is dropped and the HDR10 base layer is kept). Profile 5 is skipped, because it has no HDR10 fallback.
   - Skip HDR and Dolby Vision files that are not 4K
   - Deinterlace interlaced sources, using the method with the better resulting quality
   - Convert everything else to HEVC with NVENC using constant quality (start around CQ 26), with a preset favoring quality over speed. 10-bit output is not a priority.
   - Copy all audio streams unchanged
   - Copy subtitle streams where MKV supports them; convert those it does not (for example MP4 `mov_text` to SRT) so they play correctly
   - External subtitle sidecars (`.srt`, `.idx`/`.sub`) whose base name matches the video are embedded into the new `.mkv`. When the original is renamed `.old`, the embedded sidecars are renamed `.old` with it, so Plex does not show the subtitles twice. Sidecars whose name does not match their video are left as they are: Safety Not Guaranteed, The Year Without a Santa Claus, and The Worlds End (case differs).
   - Output `.mkv` and keep the original base filename. The extension changes when the source is not `.mkv`; this is accepted.
   - English default tracks: the first English audio track (not commentary) is the default audio; if there is no English audio, audio flags are left as they are. The first full (not forced) English subtitle track is the default subtitle, or the English forced track if there is no full one; with no English subtitles, no subtitle track is default. Language tags `en` and `eng` count as English; untagged tracks do not. Applies to every file the flow handles, skipped files included: a skipped `.mkv` gets its flags set in place with `mkvpropedit` (no re-encode); a skipped file in another container is remuxed to `.mkv` (video copied, original renamed `.old`) only when its flags need to change.
   - Only replace the original if the new file is smaller; otherwise keep the original and mark the file as processed
   - On replacement, rename the original by appending `.old` (for example `Movie.mkv.old`). Plex, Sonarr, Radarr, and Tdarr ignore that extension. Originals are kept until I approve a purge.
6. **Tracking**: log one row per file handled, including skipped files: path, source codec, resolution, size before, size after, bytes saved, CQ, encode time, outcome (replaced, kept because larger, skipped and why), and timestamp. Store the log as CSV in the GitHub repo so stats can be generated when the project is complete. Since 2026-10-21 `logs/transcode-log.csv` is tracked (the rest of `logs/` is ignored); rows for the test library, which carry release names, were moved to the untracked `logs/transcode-log-tests.csv`.
7. **Testing**:
   - Claude picks 10 candidate titles, including dark and grainy content and at least one 4K HDR file, and copies them into a dedicated test folder on Bandersnatch. The Tdarr test library points only at that folder.
   - The full flow, including the `.old` rename, runs on the copies. Library files are not touched during testing.
   - Do not touch the full library until I approve.
8. **Batches**: after approval, process the library in batches, alphabetically by folder.
9. **Scheduling**: Straylight is my daily desktop. The node runs from 10 PM to 6 AM at full GPU capacity. I must be able to turn it on and off during the day whenever I choose. Explain how. Decided 2026-10-21: no fixed schedule. Encoding runs whenever there is work, and I pause it by hand during video calls and games.
10. **Downstream**: confirm Plex, Sonarr, and Radarr pick up replaced files without seeing them as missing. Note any rescan settings needed. Plex will be rescanned after the reorganization and cleanup work is done.
11. **Repository and documentation**: create a private GitHub repo `cruftbox/tdarr-install` to track progress. It holds the compose file, the exported flow JSON, the tracking log, and `README.md`. No secrets or API keys. The README covers architecture, ports, paths, the flow logic, how to adjust CQ, how to pause everything, and how to add more libraries.

## Working style


- Propose, then wait for my approval before deploying or changing anything on either machine.
- Check current Tdarr documentation; flows and node settings change between versions.
- Keep writing dry and precise. No em dashes.
