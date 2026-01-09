import { Client } from "@notionhq/client";
import crypto from "crypto";
import fetch from "node-fetch";

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const DATABASE_ID = process.env.DATABASE_ID;
const GH_TOKEN = process.env.GH_TOKEN;
const IMAGE_REPO = process.env.IMAGE_REPO;
const IMAGE_BRANCH = process.env.IMAGE_BRANCH;

async function uploadToGithub(buffer, filename) {
  const apiUrl = `https://api.github.com/repos/${IMAGE_REPO}/contents/images/${filename}`;

  const res = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      message: `upload image ${filename}`,
      content: buffer.toString("base64"),
      branch: IMAGE_BRANCH,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }

  return `https://raw.githubusercontent.com/${IMAGE_REPO}/${IMAGE_BRANCH}/images/${filename}`;
}

async function getFirstImageAndTransfer(pageId) {
  const blocks = await notion.blocks.children.list({
    block_id: pageId,
    page_size: 50,
  });

  for (const block of blocks.results) {
    if (block.type !== "image") continue;

    const img =
      block.image.type === "file"
        ? block.image.file.url
        : block.image.external.url;

    const res = await fetch(img);
    const buffer = Buffer.from(await res.arrayBuffer());

    const hash = crypto.createHash("sha1").update(buffer).digest("hex");
    const filename = `${hash}.png`;

    const githubUrl = await uploadToGithub(buffer, filename);

    return {
      type: "external",
      external: { url: githubUrl },
    };
  }

  return null;
}

async function main() {
  const pages = await notion.databases.query({
    database_id: DATABASE_ID,
  });

  for (const page of pages.results) {
    if (page.cover) continue;

    const cover = await getFirstImageAndTransfer(page.id);
    if (!cover) continue;

    await notion.pages.update({
      page_id: page.id,
      cover,
    });

    console.log(`✅ 封面已转存并更新: ${page.id}`);
  }
}

main().catch(console.error);
