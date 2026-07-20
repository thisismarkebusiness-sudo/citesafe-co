/**
 * Fast keynote frame render: one Chrome session, 24fps, smooth cursor paths.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { spawn } from "child_process";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FPS = 24;
const DURATION = 52;
const TOTAL = FPS * DURATION;
const framesDir = path.join(__dirname, "frames");
const animPath = path.join(__dirname, "anim.html");
const animUrl = pathToFileURL(animPath).href;
const chrome =
  process.env.CHROME ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ffmpeg = "ffmpeg";

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", shell: false });
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))
    );
  });
}

async function main() {
  fs.mkdirSync(framesDir, { recursive: true });
  for (const f of fs.readdirSync(framesDir)) {
    if (/^f\d+\.png$/i.test(f) || f.startsWith("_")) {
      fs.unlinkSync(path.join(framesDir, f));
    }
  }

  console.log(`Launch Chrome → ${TOTAL} frames @ ${FPS}fps`);
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: "new",
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    args: [
      "--hide-scrollbars",
      "--disable-gpu",
      "--font-render-hinting=none",
      "--no-sandbox",
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });

  const t0 = Date.now();
  for (let i = 0; i < TOTAL; i++) {
    const url = `${animUrl}?f=${i}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    // let layout settle
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const out = path.join(framesDir, `f${String(i).padStart(4, "0")}.png`);
    await page.screenshot({ path: out, type: "png", clip: { x: 0, y: 0, width: 1920, height: 1080 } });
    if (i % 48 === 0 || i === TOTAL - 1) {
      const elapsed = (Date.now() - t0) / 1000;
      const rate = (i + 1) / elapsed;
      const eta = Math.round((TOTAL - i - 1) / rate);
      console.log(`  ${i + 1}/${TOTAL}  ${rate.toFixed(1)} f/s  eta ~${eta}s`);
    }
  }
  await browser.close();
  console.log(`Frames done in ${Math.round((Date.now() - t0) / 1000)}s`);

  const silent = path.join(__dirname, "keynote_anim_silent.mp4");
  console.log("Stitching silent...");
  await run(ffmpeg, [
    "-y",
    "-framerate",
    String(FPS),
    "-i",
    path.join(framesDir, "f%04d.png"),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "18",
    "-preset",
    "veryfast",
    "-movflags",
    "+faststart",
    silent,
  ]);

  const clk = path.join(__dirname, "_clk.wav");
  const scoreFinal = path.join(__dirname, "_score_final.m4a");
  const outMp4 = path.join(path.dirname(__dirname), "keynote.mp4");

  console.log("Click score...");
  await run(ffmpeg, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=44100:cl=mono",
    "-t",
    String(DURATION),
    "-af",
    "aeval='0.55*sin(2*PI*1600*t)*exp(-55*mod(t+0.001,100))*((between(t,12.55,12.8)+between(t,29.4,29.65)+between(t,31.05,31.3)+between(t,32.4,32.65)+between(t,33.75,34)+between(t,35.1,35.35)+between(t,36.45,36.7)+between(t,40.7,40.95)))+0.22*sin(2*PI*900*t)*exp(-18*mod(t,0.5))*(between(t,14,23.5))'",
    "-c:a",
    "pcm_s16le",
    clk,
  ]);

  console.log("Ambient mix...");
  await run(ffmpeg, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=196:duration=${DURATION}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=247:duration=${DURATION}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=82:duration=${DURATION}`,
    "-f",
    "lavfi",
    "-i",
    `anoisesrc=color=pink:d=${DURATION}:amplitude=0.25`,
    "-i",
    clk,
    "-filter_complex",
    "[0]volume=0.035,afade=t=in:st=8:d=3,afade=t=out:st=48:d=3[a1];[1]volume=0.025,afade=t=in:st=10:d=3,afade=t=out:st=47:d=3[a2];[2]volume=0.07,lowpass=f=110,afade=t=in:st=8:d=3,afade=t=out:st=48:d=3[a3];[3]volume=0.018,lowpass=f=380,afade=t=in:st=8:d=4[a4];[4]volume=1.1[a5];[a1][a2][a3][a4][a5]amix=inputs=5:normalize=0,alimiter=limit=0.78,volume=1.25[aout]",
    "-map",
    "[aout]",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    scoreFinal,
  ]);

  console.log("Mux final...");
  await run(ffmpeg, [
    "-y",
    "-i",
    silent,
    "-i",
    scoreFinal,
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    "-movflags",
    "+faststart",
    outMp4,
  ]);

  const poster = path.join(framesDir, "f0840.png");
  if (fs.existsSync(poster)) {
    fs.copyFileSync(poster, path.join(path.dirname(__dirname), "keynote-poster.png"));
  }

  const size = fs.statSync(outMp4).size;
  console.log(`DONE ${outMp4} bytes=${size} total_s=${Math.round((Date.now() - t0) / 1000)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
