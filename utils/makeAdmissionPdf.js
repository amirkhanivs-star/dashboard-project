import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";
import ejs from "ejs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function makeAdmissionPdf(admissionRow, baseUrl = "") {
  // 1) pdf folder ensure
  const pdfDir = path.join(__dirname, "..", "uploads", "pdfs");
  if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });

  // 2) file path
  const pdfPath = path.join(pdfDir, `admission_${admissionRow.id}.pdf`);

  // 3) EJS template render
  const templatePath = path.join(__dirname, "..", "views", "pdf", "admission.ejs");

  const html = await ejs.renderFile(templatePath, {
    a: admissionRow,
    baseUrl,
    bannerSrc: "img/ivs-banner.png",
  });

  // 4) HTML -> PDF
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  // stable render
  await page.setViewport({ width: 1200, height: 1600, deviceScaleFactor: 1 });

  await page.setContent(html, { waitUntil: "networkidle0" });

  // print mode
  await page.emulateMediaType("print");

  await page.pdf({
    path: pdfPath,
    format: "A4",
    printBackground: true,

    // ✅ full page, no outside margin
    margin: { top: 0, right: 0, bottom: 0, left: 0 },

    // ✅ respect @page size/margin
    preferCSSPageSize: true,

    // ✅ VERY IMPORTANT: keep scale = 1 so no outer white space
    scale: 1,
  });

  await browser.close();
  return pdfPath;
}
