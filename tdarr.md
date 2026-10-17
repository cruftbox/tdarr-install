# Project: Tdarr transcoding with GPU offload to Straylight

## Goal

Shrink my Plex library by converting older codecs to HEVC. The Tdarr server runs on my NAS (Bandersnatch). The actual encoding happens on my desktop (Straylight) using the RTX 4070 Super's NVENC encoder. Results replace the originals in place so Plex, Sonarr, and Radarr keep working.

## Environment

- **Bandersnatch**: QNAP TS-451 NAS, Intel Celeron (Bay Trail, x86_64), 16 GB RAM (upgraded), QTS 5.x, Container Station (Docker). Holds all media and runs Plex. It cannot do meaningful transcoding. Plex stream transcoding on the NAS is out of scope for this project.
- **Straylight**: Windows 11, Ryzen 7 5700X, 64 GB RAM, RTX 4070 Super and RTX 2070 Super. The 2070 Super is reserved for Ollama and must not be used by Tdarr. Has local NVMe storage. WSL2 Ubuntu is installed, but the Tdarr node runs natively on Windows, not in WSL.
- Gigabit LAN between the two.
- Library is mostly 1080p or below. Many files are already HEVC.
- Claude has SSH key access to Bandersnatch as `<nas-user>`. Passwordless sudo for `<nas-user>` was set up on 2026-10-16 in `/usr/etc/sudoers.d/<nas-user>`. The root filesystem is a RAM disk, so `/tmp/config/autorun.sh` on the flash config partition (with `Misc Autorun = TRUE`) recreates the rule at boot. Not yet verified across a reboot.
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

- Recyclarr is installed. If it applies TRaSH custom formats that score x265 negatively for HD, Sonarr and Radarr may treat converted files as upgrade candidates and download replacements. Check the custom format scores before the first real batch.
- Bazarr manages subtitles and may add new sidecar files after conversion.

## Requirements

1. **Inspect first**: confirm Docker and compose availability on Bandersnatch, whether `docker` needs root, the media paths, and free disk space. On Straylight, pick a local NVMe path for the transcode cache.
2. **Tdarr Server** on Bandersnatch in Docker, current stable release (not beta). Mount the media library read-write at the same container path other services use. Its internal node gets 0 transcode workers. Runs continuously until the project ends.
3. **Tdarr Node** on Straylight as the native Windows app, current stable release, running as a background service. Start with the **unmapped** node type (files transferred over Tdarr's API) so no SMB share mapping is needed. Explain what would change if I later switch to a mapped node with path translators. The service is removed when the project ends.
4. **GPU pinning**: all encodes run on the 4070 Super only, pinned by UUID. Verify during a live job with `nvidia-smi dmon -s u`: the `enc` column must be active on the 4070 Super and zero on the 2070 Super.
5. **Flow logic**, built with Tdarr Flows:
   - Skip files whose video is already HEVC or AV1. Leave them unchanged, including their container. Exception: 4K files.
   - 4K files (wider than 3000 px or taller than 1200 px) of any codec are downscaled to 1080p and encoded to HEVC. Ultrawide 1080p (for example 2592x1080) is not 4K. Plex's database lists 16 such files on 2026-10-16: 5 movies, 7 episodes of The Mandalorian, 4 of Shrinking. This applies even when the 4K file is already HEVC. HDR is kept: encode 1080p HEVC 10-bit and carry the HDR metadata (color primaries, transfer, matrix, mastering display, content light level) through to the output. Verify during testing that the Tdarr ffmpeg build passes HDR metadata through NVENC.
   - Dolby Vision in 4K files: Profile 8 is converted (the Dolby Vision layer is dropped and the HDR10 base layer is kept). Profile 5 is skipped, because it has no HDR10 fallback.
   - Skip HDR and Dolby Vision files that are not 4K
   - Deinterlace interlaced sources, using the method with the better resulting quality
   - Convert everything else to HEVC with NVENC using constant quality (start around CQ 26), with a preset favoring quality over speed. 10-bit output is not a priority.
   - Copy all audio streams unchanged
   - Copy subtitle streams where MKV supports them; convert those it does not (for example MP4 `mov_text` to SRT) so they play correctly
   - External subtitle sidecars (`.srt`, `.idx`/`.sub`) whose base name matches the video are embedded into the new `.mkv`. When the original is renamed `.old`, the embedded sidecars are renamed `.old` with it, so Plex does not show the subtitles twice. Sidecars whose name does not match their video are left as they are: Safety Not Guaranteed, The Year Without a Santa Claus, and The Worlds End (case differs).
   - Output `.mkv` and keep the original base filename. The extension changes when the source is not `.mkv`; this is accepted.
   - Only replace the original if the new file is smaller; otherwise keep the original and mark the file as processed
   - On replacement, rename the original by appending `.old` (for example `Movie.mkv.old`). Plex, Sonarr, Radarr, and Tdarr ignore that extension. Originals are kept until I approve a purge.
6. **Tracking**: log one row per file handled, including skipped files: path, source codec, resolution, size before, size after, bytes saved, CQ, encode time, outcome (replaced, kept because larger, skipped and why), and timestamp. Store the log as CSV in the GitHub repo so stats can be generated when the project is complete.
7. **Testing**:
   - Claude picks 10 candidate titles, including dark and grainy content and at least one 4K HDR file, and copies them into a dedicated test folder on Bandersnatch. The Tdarr test library points only at that folder.
   - The full flow, including the `.old` rename, runs on the copies. Library files are not touched during testing.
   - Do not touch the full library until I approve.
8. **Batches**: after approval, process the library in batches, alphabetically by folder.
9. **Scheduling**: Straylight is my daily desktop. The node runs from 10 PM to 6 AM at full GPU capacity. I must be able to turn it on and off during the day whenever I choose. Explain how.
10. **Downstream**: confirm Plex, Sonarr, and Radarr pick up replaced files without seeing them as missing. Note any rescan settings needed. Plex will be rescanned after the reorganization and cleanup work is done.
11. **Repository and documentation**: create a private GitHub repo `cruftbox/tdarr-install` to track progress. It holds the compose file, the exported flow JSON, the tracking log, and `README.md`. No secrets or API keys. The README covers architecture, ports, paths, the flow logic, how to adjust CQ, how to pause everything, and how to add more libraries.

## Working style


- Propose, then wait for my approval before deploying or changing anything on either machine.
- Check current Tdarr documentation; flows and node settings change between versions.
- Keep writing dry and precise. No em dashes.
