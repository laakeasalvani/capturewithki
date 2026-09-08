# PDF feasibility spike — run this before building the PDF pipeline

Answers one question: does headless Chromium launch inside our deployed Cloud
Function runtime? It cannot be answered locally.

## 1. Add the dependency and the function

```bash
cd functions && npm install puppeteer
```

Add to `functions/index.js`, temporarily:

```js
export const pdfSpike = onCall(
  { region: 'us-west1', memory: '1GiB', timeoutSeconds: 120 },
  async () => {
    const puppeteer = (await import('puppeteer')).default;
    const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setContent('<h1>hello</h1>');
    const pdf = await page.pdf({ format: 'Letter' });
    await browser.close();
    console.log('[pdfSpike] bytes:', pdf.length);
    return { bytes: pdf.length };
  }
);
```

## 2. Deploy only this function

```bash
firebase deploy --only functions:pdfSpike --project capturewithki-69dd3
```

## 3. Call it and read the logs

```bash
firebase functions:log --only pdfSpike --project capturewithki-69dd3
```

**PASS:** a byte length over 1000.
**FAIL:** a launch error, a timeout, or a deploy that exceeds the size limit.

## 4. Delete it either way

```bash
firebase functions:delete pdfSpike --project capturewithki-69dd3
```

A leftover callable that launches a browser is an open invitation to run up a bill.

## 5. Record the answer

Write PASS or FAIL, with the log line, into this file before Task 13 begins.

**If FAIL:** do not build the PDF pipeline. The fallback is the permanent tokenized
page, which is already built and already satisfies ESIGN's requirement that a record be
retainable and accurately reproducible. Tell Laakea; do not silently substitute.
