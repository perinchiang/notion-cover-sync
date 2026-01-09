import { Client } from "@notionhq/client";
import crypto from "crypto";
import fetch from "node-fetch";

// --- 配置区域 ---
// 直接复用你现有的环境变量
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.DATABASE_ID;
const GH_TOKEN = process.env.GH_TOKEN;
const IMAGE_REPO = process.env.IMAGE_REPO;
const IMAGE_BRANCH = process.env.IMAGE_BRANCH || "main";

// ⚠️ 递归深度限制（防止嵌套太深导致超时），通常 3 层够用了
const MAX_DEPTH = 3;

/**
 * 复用你原有的上传函数
 */
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

    if (!res.ok) {
        const text = await res.text();
        if(res.status !== 422 && res.status !== 409) {
             console.error(`GitHub Upload Error: ${text}`);
             throw new Error(text);
        }
    }
    // 返回 GitHub raw 链接 (注意：由于缓存原因，刚上传完可能需要一点时间才能访问)
    return `https://raw.githubusercontent.com/${IMAGE_REPO}/${IMAGE_BRANCH}/images/${filename}`;
  } catch (e) {
    console.error("上传 GitHub 失败:", e);
    return null;
  }
}

/**
 * 递归处理 Block
 */
async function processBlocks(blockId, depth = 0) {
  if (depth > MAX_DEPTH) return;

  let hasMore = true;
  let startCursor = undefined;

  while (hasMore) {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 50, // 稍微调小一点防止超时
      start_cursor: startCursor,
    });

    for (const block of response.results) {
      // 1. 如果是图片，且是 Notion 托管的 (type === 'file')
      if (block.type === "image" && block.image.type === "file") {
        await replaceImage(block);
      }

      // 2. 如果有子 Block (例如分栏、Toggle、引用等)，递归进去查找
      if (block.has_children) {
        await processBlocks(block.id, depth + 1);
      }
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor;
  }
}

/**
 * 执行替换逻辑
 */
async function replaceImage(block) {
  const originalUrl = block.image.file.url;
  console.log(`📸 发现图片 (Block ID: ${block.id})，正在下载...`);

  try {
    // 下载
    const res = await fetch(originalUrl);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    // 生成唯一文件名 (Hash)
    const hash = crypto.createHash("sha1").update(buffer).digest("hex");
    const filename = `${hash}.png`;

    // 上传到 GitHub
    const newUrl = await uploadToGithub(buffer, filename);

    if (newUrl) {
      console.log(`🚀 上传成功: ${newUrl}`);
      
      // 更新 Notion Block
      await notion.blocks.update({
        block_id: block.id,
        image: {
          external: {
            url: newUrl
          }
        }
      });
      console.log(`✅ Notion Block 已更新为图床链接`);
    }
  } catch (err) {
    console.error(`❌ 处理图片失败: ${err.message}`);
  }
}

async function main() {
  console.log("🚀 开始正文图片清洗任务...");

  // 1. 获取所有文章
  const pages = await notion.databases.query({
    database_id: DATABASE_ID,
    // 可以在这里加 filter，比如只洗 "Published" 的文章
  });

  console.log(`📄 共找到 ${pages.results.length} 篇文章`);

  for (const page of pages.results) {
    const pageTitle = page.properties['Title']?.title[0]?.plain_text || page.id;
    console.log(`\n🔍 正在扫描文章: ${pageTitle}`);
    
    // 从 Page ID 开始遍历所有子 Block
    await processBlocks(page.id);
  }
  
  console.log("\n🎉 所有文章处理完毕！");
}

main().catch(console.error);
