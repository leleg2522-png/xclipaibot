---
name: Flora media upload / host allowlist
description: Why Flora video generation fails instantly, and the required asset-upload flow
---

# Flora rejects non-allowlisted media hosts

**Rule:** Flora only fetches input media (image/video) from an allowlisted set of hosts:
`media.flora.ai`, `storage.googleapis.com` (+ virtual-hosted), and S3 buckets. Any other
host (our own Express file server on Railway/Replit) is refused.

**Symptom when violated:** `POST /api/v1/generate` returns a valid `run_id`, reports
`estimated_seconds` and **charges credits**, then the run fails within ~16s at
`progress:100` with `error_code: GENERATION_GENERIC_ERROR`. The run detail endpoint
returns nothing useful (no inputs echoed). This looks like a content/model error but is
actually a media-fetch rejection.

**Why:** the failure is silent and generic — easy to misdiagnose as multi-replica file
serving, wrong params, or bad media content. It is none of those; it's the host allowlist.

**How to apply — required upload flow before generate:**
1. `POST /api/v1/assets` with `{ source:"signed-url", workspace_id, filename, content_type }`.
   Response: `url` = final public `media.flora.ai/...` URL, and `upload` = an ImageKit
   signed multipart form `{ url, file_field (default "file"), form_fields:{token,signature,expire,...} }`.
2. POST the raw bytes to `upload.url` as multipart/form-data: append all `upload.form_fields`,
   then append the file under `upload.file_field`.
3. Use the returned `media.flora.ai` URL in `generate` params (`image_url`/`video_url`).
   That URL is public (fetchable without auth) and reusable across API keys, so upload once
   and reuse even if a key dies mid-submit and rotation picks another key/workspace.

**Model note:** `iv2v-kling-2.6-motion` (display "Kling 2.6 Pro Motion Control") `GET
/api/v1/models` schema exposes ONLY `params.character_orientation` (`image`|`video`, default
`video`). Media inputs are NOT declared in the model schema — they still go in `generate`
`params` as `image_url`/`video_url`, but must be allowlisted-host URLs.
