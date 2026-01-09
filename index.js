import { Client } from "@notionhq/client";
import crypto from "crypto";
import fetch from "node-fetch";

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const DATABASE_ID = process.env.DATABASE_ID;
const GH_TOKEN = process.env.GH_TOKEN;
const IMAGE_REPO = process.env.IMAGE_REPO;
const IMAGE_BRANCH = process.env.IMAGE_BRANCH || "main";

// ⚠️ 设为 true 会强制重新上传封面，即使 Notion 已经有封面了
// ⚠️ 设为 false 则跳过已有封面的文章（节省资源）
// 你现在因为图床被删了，建议设为 true 跑一次，修复完后再改回 false
const FORCE_UPDATE = false; 

async function uploadToGithub(buffer, filename) {
  // 检查文件是否已存在（可选优化，避免重复上传报错，这里直接覆盖或忽略错误）
  const apiUrl = `https://api.github.com/repos/${IMAGE_REPO}/contents/images/${filename}`;

  try {
    // 先尝试获取文件，如果存在且不需要覆盖，可以 return url (此处为了简单直接 PUT 覆盖)
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
        // 如果是 422 错误通常意味着文件sha没变或者其他git问题，但也可能是文件已存在
        const text = await res.text();
        // 如果报错包含 "sha"，说明文件可能已存在且内容一致，直接返回链接即可，不算失败
        if(res.status !== 422 && res.status !== 409) {
             console.error(`GitHub Upload Error: ${text}`);
             throw new Error(text);
        }
    }

    return `https://raw.githubusercontent.com/${IMAGE_REPO}/${IMAGE_BRANCH}/images/${filename}`;
  } catch (e) {
    console.error("上传 GitHub 失败:", e);
    return null;
  }
}

async function getFirstImageAndTransfer(pageId) {
  let hasMore = true;
  let startCursor = undefined;
  
  // 循环分页查找，直到找到图片或找完所有 Block
  while (hasMore) {
    const blocks = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 100, // 提高单次获取数量
      start_cursor: startCursor,
    });

    for (const block of blocks.results) {
      // 检查 image 类型
      if (block.type === "image") {
        const imgUrl =
          block.image.type === "file"
            ? block.image.file.url
            : block.image.external.url;

        // 下载图片
        try {
            const res = await fetch(imgUrl);
            if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
            const buffer = Buffer.from(await res.arrayBuffer());

            // 生成文件名
            const hash = crypto.createHash("sha1").update(buffer).digest("hex");
            const filename = `${hash}.png`;

            // 上传
            const githubUrl = await uploadToGithub(buffer, filename);
            
            if (githubUrl) {
                return {
                    type: "external",
                    external: { url: githubUrl },
                };
            }
        } catch (err) {
            console.error(`处理图片失败 (Block ID: ${block.id}):`, err);
            continue; // 这一张失败了尝试找下一张？或者直接跳过
        }
      }
      
      // 注意：这里没有递归查找 nested blocks (如 toggle 里的图片)
      // 如果你的首图在 toggle 里，依然找不到。
    }

    hasMore = blocks.has_more;
    startCursor = blocks.next_cursor;
  }

  return null;
}

async function main() {
  console.log("🚀 开始检查 Notion 文章...");
  
  const pages = await notion.databases.query({
    database_id: DATABASE_ID,
    // 可以在这里加 filter 过滤状态，比如只处理 status=Published
  });

  console.log(`📄 共找到 ${pages.results.length} 篇文章`);

  for (const page of pages.results) {
    const pageTitle = page.properties['Title']?.title[0]?.plain_text || page.id;
    
    // 如果没有强制更新开关，且已经有封面，就跳过
    if (!FORCE_UPDATE && page.cover) {
        // console.log(`⏭️  跳过已存在封面: ${pageTitle}`);
        continue;
    }

    // 如果是强制更新，且封面已经是 GitHub 的链接，也可以选择跳过（避免重复传同样的图）
    if (FORCE_UPDATE && page.cover?.external?.url?.includes("raw.githubusercontent.com")) {
        // 可选：如果你确定之前的图床删了，这里就不要跳过，继续往下走去重新上传
        // 如果只是为了修补部分漏掉的，可以开启下面这行：
        // continue; 
    }

    console.log(`🔍 正在处理: ${pageTitle}`);

    const cover = await getFirstImageAndTransfer(page.id);
    
    if (cover) {
      await notion.pages.update({
        page_id: page.id,
        cover,
      });
      console.log(`✅ 封面更新成功: ${pageTitle}`);
    } else {
      console.log(`⚠️  未找到图片或上传失败: ${pageTitle}`);
    }
  }
}

main().catch(console.error);
