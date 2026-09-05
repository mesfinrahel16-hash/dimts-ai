# AfriVoice AI — Backend

Real server-side TTS backend for AfriVoice AI (Steps 7B + 7C). Zero external
npm dependencies — built entirely on Node's built-in `http` and `node:test`
modules, so it runs anywhere Node 18+ runs with no install step.

## What's in here

```
src/
  config/
    languages.js          Verified language/provider support matrix
  providers/
    TTSProvider.js         Abstract provider interface every adapter implements
    AzureTTSProvider.js     Real Azure Speech REST/SSML integration
    ElevenLabsProvider.js   Real ElevenLabs integration
    GeminiTTSProvider.js    Real Google Gemini TTS integration (gemini-2.5-flash-preview-tts)
    ProviderRouter.js       Picks a configured, language-capable provider
  services/
    scriptParser.js         Script -> Scene -> Dialogue parsing
    ssmlBuilder.js           Azure SSML construction (prosody, pauses, style)
    audioMerge.js            Safe WAV PCM merge; honest MP3 merge limitation
    jobQueue.js              Script -> Scene -> Voice Job -> Audio Segment pipeline
  server.js                  Dependency-free HTTP server + all routes
test/
  unit.test.js               Language matrix, script parser, audio merge, router
  pipeline.test.js            End-to-end job pipeline (mocked provider)
  http.contract.test.js       HTTP route contract tests
  gemini.test.js               Gemini provider tests (config, routing, mocked calls)
```

**Note on architecture:** routes are implemented directly inside `server.js`
(there is no separate `routes/` directory) using Node's built-in `http`
module — this keeps the backend dependency-free. There is also no standalone
`MockProvider` class server-side; the "Demo Mode" fallback shown when no real
TTS provider is configured is implemented in the frontend
(`afrivoice-ai.jsx`), not as a backend provider.

## Providers and verified language support

| Language | Azure | ElevenLabs | Gemini |
|---|---|---|---|
| Amharic (am-ET) | ✅ `am-ET-AmehaNeural`, `am-ET-MekdesNeural` | ❌ | ✅ (scoped to Amharic only) |
| English (en-US) | ✅ | ✅ | ❌ (intentionally out of scope) |
| Tigrinya (ti-ET) | ❌ | ❌ | ❌ |
| Afaan Oromo (om-ET) | ❌ | ❌ | ❌ |

Nothing routes to a language/provider pair unless it's marked `true` in
`src/config/languages.js` — see that file's header comment for the exact
verification notes and sources.

## Setup

```bash
npm install     # no-op; zero dependencies, included for convenience
cp .env.example .env
# fill in .env with real, server-side-only credentials
npm start        # starts the server on PORT (default 8787)
npm test          # runs all 32 tests
```

## Environment variables

All credentials are server-side only, read via `process.env`. **Never** put
these in frontend code, browser storage, or send them to the client.

```
AZURE_SPEECH_KEY=
AZURE_SPEECH_REGION=
ELEVENLABS_API_KEY=
GEMINI_API_KEY=
PORT=8787
```

If none are set, `GET /api/tts/status` reports `realTTSAvailable: false` and
`POST /api/tts/generate` returns `503 { code: "NOT_CONFIGURED" }` — the
frontend falls back to Demo Mode rather than faking real audio.

## API

- `GET /api/health` → `{ ok: true }`
- `GET /api/tts/status` → `{ realTTSAvailable, configuredProviders, languages }`
- `POST /api/tts/generate` → `202 { id, status, scenes: [...] }`
- `GET /api/jobs/:jobId` → job status/progress, polled by the frontend
- `GET /api/jobs/:jobId/scenes/:sceneIndex/audio` → real generated audio bytes

## Security

- API keys are read only from `process.env` — grep the codebase yourself:
  `grep -rn "process.env" src/`
- No route ever echoes back a key or secret in a response.
- Errors are always real (a failed provider request returns a real error
  state) — this backend never simulates a successful generation.
