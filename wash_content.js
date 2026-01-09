import { Client } from "@notionhq/client";
import crypto from "crypto";
import fetch from "node-fetch";
import sharp from "sharp"; // ✅ 新增引入 sharp

// --- 配置区域 ---
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.DATABASE_ID;
const GH_TOKEN = process.env.GH_TOKEN;
const IMAGE_REPO = process.env.IMAGE_REPO;
const IMAGE_BRANCH = process.env.IMAGE_BRANCH || "main";

// 递归深度
const MAX_DEPTH = 3;
// 压缩阈值 (单位: 字节) - 超过 5MB 就压缩
const COMPRESS_THRESHOLD = 5 * 1024 * 1024; 

/**
 * 转换 GitHub Raw 链接为 jsDelivr CDN 链接
 */
function convertToJsDelivr(rawUrl) {
  try {
    const regex = /https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)/;
    const match = rawUrl.match(regex);
    if (match) {
      return `https://cdn.jsdelivr.net/gh/${match[1]}/${match[2]}@${match[3]}/${match[4]}`;
    }
    return rawUrl;
  } catch (e) {
    return rawUrl;
  }
}

/**
 * ✅ 图片压缩函数
 */
async function compressImage(buffer) {
  // 如果文件小于阈值，直接返回原文件
  if (buffer.length < COMPRESS_THRESHOLD) {
    return { buffer, ext: "png" }; // 默认假设是 png，稍微不准确但不影响上传
  }

  console.log(`📉 图片过大 (${(buffer.length / 1024 / 1024).toFixed(2)} MB)，正在压缩...`);

  try {
    // 使用 sharp 进行压缩
    // 1. 转换为 jpeg (压缩率高)
    // 2. 限制最大宽度 1920px (防止超大分辨率)
    // 3. 质量 80%
    const newBuffer = await sharp(buffer)
      .resize({ width: 1920, withoutEnlargement: true }) // 只缩小不放大
      .toFormat("jpeg", { quality: 80 })
      .toBuffer();

    console.log(`📉 压缩完成: ${(newBuffer.length / 1024 / 1024).toFixed(2)} MB`);
    return { buffer: newBuffer, ext: "jpg" };
  } catch (e) {
    console.error("⚠️ 压缩失败，将尝试上传原图:", e);
    return { buffer, ext: "png" };
  }
}

async function uploadToGithub(buffer, filename) {
  const apiUrl = `https://api.github.com/repos/${IMAGE_REPO}/contents/images/${filename}`;
  try {
    const res = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        message: `upload content image ${filename}`,
        content: buffer.toString("base64"),
        branch: IMAGE_BRANCH,
      }),
    });

    if (!res.ok && res.status !== 422 && res.status !== 409) {
         const text = await res.text();
         // 如果是 422，可能是文件已存在，不报错
         if (!text.includes("sha")) {
            console.error(`GitHub Upload Error: ${text}`);
            throw new Error(text);
         }
    }
    
    return `https://cdn.jsdelivr.net/gh/${IMAGE_REPO}@${IMAGE_BRANCH}/images/${filename}`;
    
  } catch (e) {
    console.error("上传 GitHub 失败:", e);
    return null;
  }
}

async function processBlocks(blockId, depth = 0) {
  if (depth > MAX_DEPTH) return;

  let hasMore = true;
  let startCursor = undefined;

  while (hasMore) {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 50,
      start_cursor: startCursor,
    });

    for (const block of response.results) {
      if (block.type === "image" && block.image.type === "file") {
         await replaceNotionImage(block);
      }
      else if (block.type === "image" && block.image.type === "external") {
         const url = block.image.external.url;
         if (url.includes("raw.githubusercontent.com")) {
             await fixBadGithubLink(block, url);
         }
      }

      if (block.has_children) {
        await processBlocks(block.id, depth + 1);
      }
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor;
  }
}

async function replaceNotionImage(block) {
  const originalUrl = block.image.file.url;
  console.log(`📸 发现原生图片 (Block ID: ${block.id})，正在处理...`);

  try {
    const res = await fetch(originalUrl);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    const originalBuffer = Buffer.from(await res.arrayBuffer());

    // ✅ 调用压缩逻辑
    const { buffer, ext } = await compressImage(originalBuffer);

    // 生成文件名 (使用压缩后buffer的hash)
    const hash = crypto.createHash("sha1").update(buffer).digest("hex");
    const filename = `${hash}.${ext}`;

    const newUrl = await uploadToGithub(buffer, filename);

    if (newUrl) {
      console.log(`🚀 上传成功: ${newUrl}`);
      await updateBlockUrl(block.id, newUrl);
    }
  } catch (err) {
    console.error(`❌ 处理图片失败: ${err.message}`);
  }
}

async function fixBadGithubLink(block, oldUrl) {
    console.log(`🔧 发现未加速的 GitHub 链接: ${oldUrl}`);
    const newUrl = convertToJsDelivr(oldUrl);
    
    if (newUrl !== oldUrl) {
        console.log(`✨ 替换为 CDN 链接: ${newUrl}`);
        await updateBlockUrl(block.id, newUrl);
    } else {
        console.log(`⚠️ 链接转换失败，跳过`);
    }
}

async function updateBlockUrl(blockId, newUrl) {
    try {
        await notion.blocks.update({
            block_id: blockId,
            image: {
                external: {
                    url: newUrl
                }
            }
        });
        console.log(`✅ Block 更新成功`);
    } catch (e) {
        console.error(`⚠️ Notion 更新失败: ${e.body || e.message}`);
    }
}

async function main() {
  console.log("🚀 开始正文图片清洗任务 (含自动压缩)...");

  const pages = await notion.databases.query({
    database_id: DATABASE_ID,
  });

  console.log(`📄 共找到 ${pages.results.length} 篇文章`);

  for (const page of pages.results) {
    const pageTitle = page.properties['Title']?.title[0]?.plain_text || page.id;
    console.log(`\n🔍 正在扫描文章: ${pageTitle}`);
    await processBlocks(page.id);
  }
  
  console.log("\n🎉 所有任务处理完毕！");
}

main().catch(console.error);
