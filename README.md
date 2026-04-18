# Paperlib PDF Translation Extension (pdf2zh)

A [Paperlib](https://github.com/Future-Scholars/paperlib) extension that integrates [pdf2zh_next](https://github.com/Byaidu/PDFMathTranslate) for translating academic PDFs directly from your library.

## Features

- One-click PDF translation via CLI subprocess
- Preserves formulas, charts, and layout
- Real-time progress display in the detail panel
- Monolingual and bilingual output
- Configurable default open version

## Prerequisites

Install [pdf2zh_next](https://github.com/Byaidu/PDFMathTranslate):

```bash
# Using pip
pip install pdf2zh-next

# Using uv
uv tool install pdf2zh-next
```

Verify installation:

```bash
pdf2zh_next --version
```

## Installation

1. Clone and build:

```bash
git clone https://github.com/starandhonor/paperlib-pdf2zh-translate-extension.git
cd paperlib-pdf2zh-translate-extension
npm install
npm run build
```

2. In Paperlib: `File` → `Preferences` → `Extensions` → `Install from Path` → select the project root directory.

## Usage

1. Select a paper with a PDF in your library.
2. Trigger translation via one of:
   - **Right-click** → "Translate PDF (pdf2zh)"
   - **Command bar**: `Cmd/Ctrl+Shift+P` → "Translate PDF"
3. Progress is shown in the detail panel slot. Wait for completion.
4. Translated PDFs appear as updated files or supplementaries depending on your settings.

## Preferences

| Setting | Default | Description |
|---------|---------|-------------|
| Target Language | Chinese (zh) | Translation target language |
| Translation Service | Google | Backend service (Google, Bing, DeepL, OpenAI, Ollama, DeepSeek, SiliconFlow, OpenAI Compatible) |
| Output Mode | Both | Generate monolingual only, bilingual only, or both |
| Default Open | Bilingual translation | Which version opens by default after translation: original, monolingual, or bilingual |
| Timeout (minutes) | 30 | Maximum wait time per translation |
| pdf2zh_next Binary Path | `/home/user/.local/bin/pdf2zh_next` | Absolute path to the pdf2zh_next executable |

### Service-specific configuration

For OpenAI, DeepSeek, SiliconFlow, etc., set environment variables before launching Paperlib:

```bash
export OPENAI_API_KEY="sk-..."
export OPENAI_BASE_URL="https://api.openai.com/v1"
export DEEPSEEK_API_KEY="sk-..."
```

## Build

```bash
npm install
npm run build
```

Output: `dist/main.js`.

## License

MIT
