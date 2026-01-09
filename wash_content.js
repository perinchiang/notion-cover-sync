import { Client } from "@notionhq/client";
import crypto from "crypto";
import fetch from "node-fetch";
import sharp from "sharp";

// --- 配置区域 ---
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.DATABASE_ID;
const GH_TOKEN = process.env.GH_TOKEN;
const IMAGE_REPO = process.env.IMAGE_REPO;
const IMAGE_BRANCH = process.env.IMAGE_BRANCH || "main";

// 递归深度 (如果图片在分栏里，需要至少 3)
const MAX_DEPTH = 3;

// 压缩阈值: 10MB (超过此大小才压缩)
const COMPRESS_THRESHOLD = 10 * 1024 * 1024; 

/**
 * 转换 GitHub Raw 链接为 jsDelivr CDN 链接
 */
function convertToJsDelivr(rawUrl) {
  try {
    // 匹配 raw.githubusercontent.com 或 github.com/xxx/raw
    if (rawUrl.includes("raw.githubusercontent.com") || rawUrl.includes("/raw/")) {
       // 简单的字符串替换，比正则更稳健
       const newUrl = rawUrl
          .replace("raw.githubusercontent.com", "cdn.jsdelivr.net/gh")
          .replace("github.com", "cdn.jsdelivr.net/gh")
          .replace("/raw/", "/") // 处理某些特殊格式
          .replace("/main/", "@main/") // 尝试自动加版本号
          .replace("/master/", "@master/");
          
       // 如果替换后 URL 变了，说明可能是合法的
       if (newUrl !== rawUrl) return newUrl;
    }
    return rawUrl;
  } catch (e) {
    return rawUrl;
  }
}

/**
 * 图片压缩函数
 */
async function compressImage(buffer) {
  if (buffer.length < COMPRESS_THRESHOLD) {
    return { buffer, ext: "png" };
  }
  console.log(`📉 图片过大 (${(buffer.length / 1024 / 1024).toFixed(2)} MB)，正在压缩...`);
  try {
    const newBuffer = await sharp(buffer)
      .resize({ width: 2560, withoutEnlargement: true }) // 2.5K 分辨率限制
      .toFormat("jpeg", { quality: 90 }) // 高质量 JPG
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

    // 422/409 通常意味着文件已存在，不算失败，直接返回链接
    if (!res.ok && res.status !== 422 && res.status !== 409) {
         const text = await res.text();
         // 如果错误里包含 sha，说明文件已存在
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
      // --- 诊断日志：打印所有遇到的 Image 块 ---
      if (block.type === "image") {
          const type = block.image.type;
          const url = type === "file" ? block.image.file.url : block.image.external.url;
          console.log(`👀 发现图片 [${type}] (ID: ${block.id})`);
          // console.log(`   链接: ${url.substring(0, 50)}...`); // 嫌日志太长可以注释这行
          
          if (type === "file") {
              await replaceNotionImage(block);
          } else if (type === "external") {
              // 检查是否是坏链
              if (url.includes("raw.githubusercontent") || url.includes("github.com")) {
                  await fixBadGithubLink(block, url);
              } else {
                  console.log(`   ⏭️ 跳过：已经是外链且不是 GitHub Raw`);
              }
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
  console.log(`   📸 正在处理原生图片...`);
  const originalUrl = block.image.file.url;

  try {
    const res = await fetch(originalUrl);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    const originalBuffer = Buffer.from(await res.arrayBuffer());

    // 压缩逻辑
    const { buffer, ext } = await compressImage(originalBuffer);

    // 生成文件名
    const hash = crypto.createHash("sha1").update(buffer).digest("hex");
    const filename = `${hash}.${ext}`;

    const newUrl = await uploadToGithub(buffer, filename);

    if (newUrl) {
      console.log(`   🚀 上传成功，新链接: ${newUrl}`);
      await updateBlockUrl(block.id, newUrl);
    }
  } catch (err) {
    console.error(`   ❌ 失败: ${err.message}`);
  }
}

async function fixBadGithubLink(block, oldUrl) {
    console.log(`   🔧 发现 GitHub 链接，尝试修复加速...`);
    const newUrl = convertToJsDelivr(oldUrl);
    
    // 如果转换后的链接变了，才更新
    if (newUrl !== oldUrl) {
        // 修正 jsDelivr 格式: 确保 githubusercontent 变成了 jsdelivr
        if (newUrl.includes("cdn.jsdelivr.net")) {
            console.log(`   ✨ 修复为: ${newUrl}`);
            await updateBlockUrl(block.id, newUrl);
        } else {
            console.log(`   ⚠️ 无法自动转换此 GitHub 链接，跳过。`);
        }
    } else {
        console.log(`   ⚠️ 链接看似正常或无法识别，跳过`);
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
        console.log(`   ✅ Block 更新完毕！`);
    } catch (e) {
        console.error(`   ⚠️ Notion 更新 API 报错: ${e.body || e.message}`);
    }
}

async function main() {
  console.log("🚀 开始全能洗图模式 (Verbose Mode)...");

  const pages = await notion.databases.query({
    database_id: DATABASE_ID,
  });

  console.log(`📄 共找到 ${pages.results.length} 篇文章`);

  for (const page of pages.results) {
    const pageTitle = page.properties['Title']?.title[0]?.plain_text || "无标题";
    console.log(`\n🔍 扫描: ${pageTitle} (${page.id})`);
    await processBlocks(page.id);
  }
  
  console.log("\n🎉 所有任务处理完毕！");
}

main().catch(console.error);
