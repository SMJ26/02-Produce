# Cutline Studio

Cutline turns a topic into an English narrated explainer. Review and edit the draft, approve narration, then play or download the captioned 1920×1080 MP4 from Studio. The local demo uses sample writing, platform text-to-speech, and original illustrated stills.

## Run with Docker

With Docker Desktop running, start the complete application:

```sh
docker compose up --build -d --wait
```

Open [Studio](http://127.0.0.1:3000) and choose **Demo · local fixtures**. Docker includes Node.js, FFmpeg, eSpeak NG, and caption fonts. Database initialization runs automatically before Studio starts, and the worker starts automatically. No host Node.js or media tools are required.

```sh
docker compose logs -f studio worker
docker compose stop
```

Projects persist in the existing `cutline-db` volume. Docker exports persist in the shared `cutline-media` volume, separately from the host's `.media` directory. Both volumes survive `docker compose stop` and `docker compose down`; `docker compose down -v` deletes them. Stop any host Studio or worker before using the container stack.

For hosted mode, set the provider variables below in `.env` and rerun `docker compose up -d --wait`. Compose passes provider settings into the containers; host database URLs, font paths, and executable overrides are not used inside Docker. The `.env` file is excluded from the image.

## Local setup without Docker

Install Node.js 22.18 or newer and Docker with Compose. FFmpeg must include `libx264` and the `drawtext` filter.

On macOS, install the full FFmpeg build and put its binaries on PATH. [Homebrew ffmpeg-full](https://formulae.brew.sh/formula/ffmpeg-full)

```sh
brew install ffmpeg-full
export PATH="$(brew --prefix ffmpeg-full)/bin:$PATH"
```

On Debian or Ubuntu, install the media tools and font:

```sh
sudo apt-get update
sudo apt-get install ffmpeg espeak-ng fonts-dejavu-core
```

On macOS, the demo uses the English Samantha system voice by default. Set `ESPEAK_PATH` to an eSpeak NG executable to use that voice engine instead. If your FFmpeg build lacks `drawtext` or `libx264`, install a build that includes both.

From the workspace, with Docker running:

```sh
npm ci
cp .env.example .env
docker compose up -d --wait postgres
npm run db:init
npm run dev
```

On macOS, the worker defaults to Arial Bold. If the default font is unavailable, set `CAPTION_FONT` to the path of an installed bold TrueType font. The default macOS path is:

```dotenv
CAPTION_FONT="/System/Library/Fonts/Supplemental/Arial Bold.ttf"
```

Open a second terminal in the workspace. On macOS, repeat the PATH export above in terminals that run the worker or media checks:

```sh
npm run worker
```

Open [Studio on localhost](http://127.0.0.1:3000). Enter **How the moon shapes the tides**, select **2 minutes** and **Demo · local fixtures**, then generate the draft. Edit a line and select **Approve and render**. When the job reaches 100%, play the video or select **Download MP4**. Keep Studio and the worker running during the demo. Reloading Studio in the same browser restores the current draft or job.

## Hosted providers

Add the following to `.env` using your account's values, restart Studio and the worker, and choose **Hosted providers**:

```dotenv
OPENAI_API_KEY=<your OpenAI API key>
OPENAI_SCRIPT_MODEL=gpt-4.1-mini
ELEVENLABS_API_KEY=<your ElevenLabs API key>
ELEVENLABS_VOICE_ID=<an English voice ID available to your account>
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
```

Hosted drafting calls OpenAI. ElevenLabs receives the edited script only after approval. It returns speech and character timestamps, which the worker maps to phrase ranges on the decoded 48 kHz audio. The target duration guides writing. The worker checks the actual hosted narration duration and asks for a script edit if it falls outside 2–5 minutes. Missing configuration is reported at the relevant step, and the demo works with blank keys. [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) · [ElevenLabs timed speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)

| Environment variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string shared by Studio and worker. The example uses the Compose port and local development credentials. |
| `MEDIA_ROOT` | Local media directory, relative to the workspace or absolute. Keep the same value in Studio and worker. |
| `FFMPEG_PATH`, `FFPROBE_PATH` | Optional binary paths. Defaults are `ffmpeg` and `ffprobe` on PATH. |
| `CAPTION_FONT` | TrueType font used for burned-in captions. The Linux default is DejaVu Sans Bold. |
| `ESPEAK_PATH` | Optional eSpeak NG binary path. Linux defaults to `espeak-ng` on PATH. |

## Verification

From the workspace:

```sh
npm run check
npm run build
npm run verify:timeline
npm run verify:media
```

The media fixture uses an original two-color visual and two audio pulses at known sample offsets. It renders a real MP4, checks FFprobe stream properties and all frame timestamps, then decodes the frames and audio to assert the visual cut, caption windows, and pulse onsets. It prints the fixture MP4 path.

For the database and API integration check without Docker application containers, run `docker compose up -d --wait postgres`, `npm run db:init`, and `npm run dev`. Leave the regular worker stopped and run this in a second terminal:

```sh
npm run verify:workflow
```

The check starts and controls its own worker. It edits the draft, verifies approval idempotency, kills the worker during rendering, waits for recovery, verifies byte-range playback and one ready export, then downloads and probes the 120-second MP4. It also checks missing hosted configuration when the key is blank and confirms a failed job has no downloadable export. Use `STUDIO_URL` if Studio is on a different port. The check writes its demo project to the local database and prints the path to the downloaded MP4.

## Implementation

- Studio and its API run in Next.js. Postgres stores drafts, approved script snapshots, and job state. Status polling resumes after refresh.
- The media worker leases a job with a heartbeat and an attempt counter. An expired lease makes the job available again. Attempt-specific paths and lease-fenced updates prevent an expired worker from exposing its output. The worker verifies the MP4 before publishing the only downloadable reference. Completed hosted narration is reusable. An interrupted paid request without a saved response requires checking provider usage before a new approval.
- The [v1 schema](fixtures/timeline-v1.schema.json) defines the interchange contract. This renderer supports a subset with still-image cuts, one narration track, and phrase captions. Visual plans reference aligned phrase IDs. The compiler resolves original illustrations by keyword and uses a neutral illustration when none match. It computes cut and caption edges from integer samples and validates coverage before invoking FFmpeg.
- The catalog is generated locally by `src/planner.ts` and contains the project's original orbit, terrain, systems, sequence, and neutral artwork. The timed audio and test plates are generated by `scripts/verify-media.ts`. The project uses no Produce media.
- This is a single-user, loopback-only Studio. Drafts and jobs persist in Postgres, and the browser keeps a pointer to its current project. The catalog is small and illustrative, and demo writing is a generic fixture adapted to the topic. The worker cleans earlier attempt directories when retrying a job. Removing old projects and exports is manual. No YouTube integration, billing, collaboration, or distributed rendering is included.
