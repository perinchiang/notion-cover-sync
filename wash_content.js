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

// 递归深度
const MAX_DEPTH = 3;

// 压缩阈值: 5MB
const COMPRESS_THRESHOLD = 5 * 1024 * 1024; 

/**
 * 判断是否已经是“我自己图床”的图片
 */
function isMyRepoImage(url) {
    // 只要链接里包含仓库名，就认为是自家的图
    return url.includes(IMAGE_REPO);
}

/**
 * 还原 CDN 链接回 Raw (为了下载大图)
 */
function convertToRaw(url) {
    try {
        if (url.includes("cdn.jsdelivr.net")) {
            const regex = /cdn\.jsdelivr\.net\/gh\/([^/]+)\/([^@]+)@([^/]+)\/(.+)/;
            const match = url.match(regex);
            if (match) return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}`;
            
            // 简写模式
            const regexSimple = /cdn\.jsdelivr\.net\/gh\/([^/]+)\/([^/]+)\/(.+)/;
            const matchSimple = url.match(regexSimple);
            if (matchSimple) return `https://raw.githubusercontent.com/${matchSimple[1]}/${matchSimple[2]}/${IMAGE_BRANCH}/${matchSimple[3]}`;
        }
    } catch (e) {}
    return url;
}

/**
 * 转换 Raw 为 CDN (为了修复链接)
 */
function convertToJsDelivr(rawUrl) {
    try {
        if (rawUrl.includes("raw.githubusercontent.com") || rawUrl.includes("/raw/")) {
           const newUrl = rawUrl
              .replace("raw.githubusercontent.com", "cdn.jsdelivr.net/gh")
              .replace("github.com", "cdn.jsdelivr.net/gh")
              .replace("/raw/", "/")
              .replace("/main/", "@main/") 
              .replace("/master/", "@master/");
           return newUrl;
        }
    } catch (e) {}
    return rawUrl;
}

async function compressImage(buffer) {
  try {
    // 1. 获取图片元数据
    const metadata = await sharp(buffer).metadata();
    let ext = metadata.format;
    
    // 规范化后缀: jpeg -> jpg
    if (ext === "jpeg") ext = "jpg";
    if (!ext) ext = "png"; // 兜底

    // 2. 如果图片小于阈值，不压缩，但返回正确的后缀
    if (buffer.length < COMPRESS_THRESHOLD) {
      return { buffer, ext }; 
    }

    console.log(`📉 图片过大 (${(buffer.length / 1024 / 1024).toFixed(2)} MB)，执行强力压缩...`);
    
    // 3. 大图压缩
    const newBuffer = await sharp(buffer)
      .resize({ width: 2560, withoutEnlargement: true }) 
      .toFormat("jpeg", { quality: 85 })
      .toBuffer();
      
    return { buffer: newBuffer, ext: "jpg" };

  } catch (e) {
    console.error("⚠️ 图片识别或压缩失败，降级处理:", e);
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
        message: `upload external image ${filename}`,
        content: buffer.toString("base64"),
        branch: IMAGE_BRANCH,
      }),
    });

    if (!res.ok) {
        const text = await res.text();
        if (!text.includes("sha")) { // 忽略文件已存在错误
             console.error(`GitHub Upload Error: ${text}`);
             throw new Error(text);
        }
    }
    // 返回 CDN 链接
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
      if (block.type === "image") {
          const type = block.image.type;
          
          if (type === "file") {
              // 情况1: Notion 原生图 -> 必须搬走
              await handleDownloadAndUpload(block, block.image.file.url, "NotionFile");
          } 
          else if (type === "external") {
              const url = block.image.external.url;
              
              if (isMyRepoImage(url)) {
                  // 情况2: 已经是自家的图 -> 检查是否是坏链 (Raw -> CDN)
                  await fixBadGithubLink(block, url);
              } else {
                  // 情况3: 别人的外链 -> 抓回来
                  await handleDownloadAndUpload(block, url, "ExternalLink");
              }
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

// 核心逻辑：下载 -> 压缩 -> 上传 -> 替换
async function handleDownloadAndUpload(block, url, sourceType) {
    console.log(`📥 发现 [${sourceType}] 图片，准备搬运... (ID: ${block.id})`);
    
    const downloadUrl = convertToRaw(url);

    try {
        const res = await fetch(downloadUrl);
        if (!res.ok) throw new Error(`下载失败 ${res.status}`);
        
        const originalBuffer = Buffer.from(await res.arrayBuffer());

        // 压缩处理
        const { buffer, ext } = await compressImage(originalBuffer);

        // 生成 Hash 文件名
        const hash = crypto.createHash("sha1").update(buffer).digest("hex");
        const filename = `${hash}.${ext}`;

        // 上传到 GitHub
        const newUrl = await uploadToGithub(buffer, filename);

        // 更新 Notion
        if (newUrl && newUrl !== url) {
            console.log(`   🚀 搬运成功: ${newUrl}`);
            await notion.blocks.update({
                block_id: block.id,
                image: {
                    external: { url: newUrl }
                }
            });
            console.log("   ✅ Notion Block 已更新");
        } else {
            console.log("   ⚠️ URL 未变或上传失败，跳过更新");
        }

    } catch (e) {
        console.error(`   ❌ 搬运失败: ${e.message}`);
    }
}

async function fixBadGithubLink(block, oldUrl) {
    const newUrl = convertToJsDelivr(oldUrl);
    if (newUrl !== oldUrl && newUrl.includes("cdn.jsdelivr.net")) {
        console.log(`🔧 修复自家图床链接: ${oldUrl} -> ${newUrl}`);
        try {
            await notion.blocks.update({
                block_id: block.id,
                image: { external: { url: newUrl } }
            });
            console.log("   ✅ 链接已修复");
        } catch (e) {
            console.error(`   ⚠️ 修复失败: ${e.message}`);
        }
    }
}

async function main() {
  console.log("🚀 开始增量洗图 (只检查最近修改且已发布的文章)...");

  // 1. 设定时间范围：过去 2 小时
  const timeWindow = new Date(new Date().getTime() - 2 * 60 * 60 * 1000).toISOString();

  // 2. 查询数据库：加入双重过滤 (时间 AND 状态)
  const pages = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      and: [
        {
          timestamp: "last_edited_time",
          last_edited_time: {
            on_or_after: timeWindow,
          },
        },
        // 👇 这一段是新增的，保护你的隐私 👇
        {
          property: "status", // 请确保你的 Notion 列名是小写 status
          select: {
            equals: "Published" // 只有发布状态的文章才处理
          }
        }
      ]
    },
  });

  if (pages.results.length === 0) {
      console.log("💤 最近没有符合条件(已发布且刚修改)的文章，脚本休息。");
      return;
  }

  console.log(`⚡️ 发现 ${pages.results.length} 篇待处理文章...`);

  for (const page of pages.results) {
    const pageTitle = page.properties['Title']?.title[0]?.plain_text || "无标题";
    console.log(`\n🔍 扫描: ${pageTitle}`);
    await processBlocks(page.id);
  }
  
  console.log("\n🎉 任务完成！");
}

main().catch(console.error);
