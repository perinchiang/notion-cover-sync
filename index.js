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

// ✨ 改动：从环境变量读取开关，默认 false
// 这样就可以在 GitHub Actions 界面上手动控制了
const FORCE_UPDATE = process.env.FORCE_UPDATE === 'true'; 

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
        message: `upload image ${filename}`,
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

    // ✨ 改动：统一使用 jsDelivr CDN 链接
    // 格式：https://cdn.jsdelivr.net/gh/用户/仓库@分支/路径
    return `https://cdn.jsdelivr.net/gh/${IMAGE_REPO}@${IMAGE_BRANCH}/images/${filename}`;
  } catch (e) {
    console.error("上传 GitHub 失败:", e);
    return null;
  }
}

async function getFirstImageAndTransfer(pageId) {
  let hasMore = true;
  let startCursor = undefined;
  
  while (hasMore) {
    const blocks = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 100, 
      start_cursor: startCursor,
    });

    for (const block of blocks.results) {
      if (block.type === "image") {
        const imgUrl =
          block.image.type === "file"
            ? block.image.file.url
            : block.image.external.url;

        try {
            const res = await fetch(imgUrl);
            if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
            const buffer = Buffer.from(await res.arrayBuffer());

            const hash = crypto.createHash("sha1").update(buffer).digest("hex");
            // 注意：这里封面图我暂时保留了强制 .png，因为 notion 原生导出大多兼容 png
            // 如果你想这里也精准识别后缀，需要引入 sharp 库并在 package.json 添加它
            const filename = `${hash}.png`;

            const githubUrl = await uploadToGithub(buffer, filename);
            
            if (githubUrl) {
                return {
                    type: "external",
                    external: { url: githubUrl },
                };
            }
        } catch (err) {
            console.error(`处理图片失败 (Block ID: ${block.id}):`, err);
            continue; 
        }
      }
    }
    hasMore = blocks.has_more;
    startCursor = blocks.next_cursor;
  }
  return null;
}

async function main() {
  console.log("🚀 开始检查 Notion 文章封面...");
  if (FORCE_UPDATE) {
      console.log("⚠️ 注意：已开启【强制更新】模式，将覆盖现有封面！");
  }
  
  const pages = await notion.databases.query({
    database_id: DATABASE_ID,
  });

  console.log(`📄 共找到 ${pages.results.length} 篇文章`);

  for (const page of pages.results) {
    const pageTitle = page.properties['Title']?.title[0]?.plain_text || page.id;
    
    if (!FORCE_UPDATE && page.cover) {
        continue;
    }

    // 即使强制更新，如果已经是自家图床 CDN 链接，也跳过 (避免重复上传)
    if (FORCE_UPDATE && page.cover?.external?.url?.includes(IMAGE_REPO)) {
        continue; 
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
