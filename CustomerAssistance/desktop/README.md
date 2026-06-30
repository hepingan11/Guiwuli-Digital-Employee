# Customer Assistance Agent Desktop

Electron desktop shell for the Windows OCR customer-service copilot.

## Run

```bash
npm install
npm run build
npm start
```

For hot reload during development:

```bash
npm run dev
```

The npm scripts use `scripts/start-electron.cjs`, which clears `ELECTRON_RUN_AS_NODE` before starting Electron. This avoids Electron being launched in Node compatibility mode on machines where that environment variable is set globally.

## Current Scope

- Enumerates Windows screen/window capture sources with Electron `desktopCapturer`.
- Saves desktop settings under Electron `userData`.
- Provides an OCR service boundary in `src/main/services/ocr-service.cjs`.
- Maintains local conversation memory in `src/main/services/conversation-memory.cjs`.
- Reuses the existing FastAPI backend through:
  - `POST /api/conversations`
  - `POST /api/messages`
  - `GET /api/conversations/{id}/suggestion`
- Keeps the product behavior as reply suggestions only. It does not auto-send messages to chat apps.

## Next OCR Integration Point

The PaddleOCR cloud provider is wired in `src/main/services/ocr-service.cjs`.

1. Select `PaddleOCR` in the OCR selector.
2. Set `PaddleOCR Token` in the app settings, or start the app with `PADDLEOCR_TOKEN`.
3. Click `识别当前屏`.

The provider follows the official job API flow:

```text
POST /api/v2/ocr/jobs
  -> poll GET /api/v2/ocr/jobs/{jobId}
  -> download resultUrl.jsonUrl
  -> parse layoutParsingResults markdown text
```

The default model is `PaddleOCR-VL-1.6`, with these optional flags disabled:

```json
{
  "useDocOrientationClassify": false,
  "useDocUnwarping": false,
  "useLayoutDetection": true,
  "useChartRecognition": false,
  "promptLabel": "ocr",
  "visualize": false,
  "prettifyMarkdown": false
}
```

PaddleOCR-VL may include markdown or HTML image tags for avatars, emoji, and embedded pictures. The desktop parser strips markdown images, `<img>` blocks, HTML tags, image paths, and standalone time labels before creating chat messages.

For chat screenshots, the parser also infers sender roles:

- Left-side message or avatar box -> `customer`
- Right-side message or avatar box -> `agent`
- Standalone timestamp -> `time`

`time` events are kept in local memory for display, but they are not sent to the backend suggestion API.

Layout detection stays enabled because sender inference needs text or avatar coordinates. Pure OCR mode can return clean text, but it often does not include enough position data to distinguish left-side customer messages from right-side agent messages.

For a local OCR deployment later, replace the provider implementation in `src/main/services/ocr-service.cjs`:

1. Capture the selected window or region.
2. Run PaddleOCR or an ONNX Runtime text-recognition pipeline locally.
3. Convert OCR blocks into normalized messages.
4. Let `conversation-memory.cjs` handle deduplication and accumulated context.

During the framework stage, paste sample chat text into the UI to exercise the full memory and backend suggestion pipeline.

## Zhipu OCR

The desktop app also supports Zhipu OCR through:

```text
POST https://open.bigmodel.cn/api/paas/v4/files/ocr
```

Configure it by selecting `Zhipu OCR` in the OCR dropdown and setting `Zhipu OCR Token`, or by starting the app with `ZHIPU_OCR_TOKEN`.

The request uses:

```text
tool_type=hand_write
language_type=CHN_ENG
probability=true
```

Zhipu OCR returns `words_result[].location`, so sender inference uses text block coordinates directly:

- text block left of the inferred threshold -> `customer`
- text block right of the inferred threshold -> `agent`
- timestamp-like text -> `time`
