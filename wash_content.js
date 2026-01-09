import { Client } from "@notionhq/client";
import crypto from "crypto";
import fetch from "node-fetch";

// --- 配置区域 ---
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.DATABASE_ID;
const GH_TOKEN = process.env.GH_TOKEN;
const IMAGE_REPO = process.env.IMAGE_REPO;
const IMAGE_BRANCH = process.env.IMAGE_BRANCH || "main";

// 递归深度
const MAX_DEPTH = 3;

/**
 * 转换 GitHub Raw 链接为 jsDelivr CDN 链接
 * 输入: https://raw.githubusercontent.com/user/repo/branch/path/to/file.png
 * 输出: https://cdn.jsdelivr.net/gh/user/repo@branch/path/to/file.png
 */
function convertToJsDelivr(rawUrl) {
  try {
    // 使用正则提取关键信息
    const regex = /https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)/;
    const match = rawUrl.match(regex);
    
    if (match) {
      const user = match[1];
      const repo = match[2];
      const branch = match[3];
      const path = match[4];
      return `https://cdn.jsdelivr.net/gh/${user}/${repo}@${branch}/${path}`;
    }
    return rawUrl; // 匹配失败则返回原样
  } catch (e) {
    return rawUrl;
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
         console.error(`GitHub Upload Error: ${text}`);
         throw new Error(text);
    }
    
    // ✅ 重点修改：直接返回 CDN 链接
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
      // -------------------------------------------------
      // 情况 1: Notion 原生图片 (需要下载 -> 上传 -> 替换)
      // -------------------------------------------------
      if (block.type === "image" && block.image.type === "file") {
         await replaceNotionImage(block);
      }

      // -------------------------------------------------
      // 情况 2: 已经是 GitHub 链接但不是 CDN (需要修复链接)
      // -------------------------------------------------
      else if (block.type === "image" && block.image.type === "external") {
         const url = block.image.external.url;
         if (url.includes("raw.githubusercontent.com")) {
             await fixBadGithubLink(block, url);
         }
      }

      // 递归处理子块
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
    const buffer = Buffer.from(await res.arrayBuffer());

    const hash = crypto.createHash("sha1").update(buffer).digest("hex");
    const filename = `${hash}.png`;

    const newUrl = await uploadToGithub(buffer, filename);

    if (newUrl) {
      console.log(`🚀 上传并生成 CDN 链接: ${newUrl}`);
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

// 统一的更新 Block 函数
async function updateBlockUrl(blockId, newUrl) {
    try {
        await notion.blocks.update({
            block_id: blockId,
            image: {
                // ✅ 修复了之前的 validation error，不传 type: "external"
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
  console.log("🚀 开始正文图片清洗任务 (含坏链修复)...");

  // 这里为了测试，先不加时间过滤，跑一次全量
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
