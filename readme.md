# Notion Image Sync & Wash (全能版)

这是一个自动化的 Notion 图片管理工具，包含两个核心功能：
1. **封面同步 (Cover Sync)**：自动提取 Notion 页面第一张图片作为封面，并上传到 GitHub 图床。
2. **正文洗图 (Content Wash)**：自动扫描文章正文，将 Notion 原生图片或第三方外链图片下载、压缩并“洗”入 GitHub 图床，替换为永久 CDN 链接。
![实例](https://images-1314261959.cos.ap-guangzhou.myqcloud.com/img/20260109094934009.png)
## ✨ 核心功能

- **🖼 自动封面**：没有封面的文章，自动取首图设为封面。
- **🚿 正文洗图**：将 Notion 临时链接替换为 GitHub + jsDelivr 永久链接，防止链接过期。
- **📉 智能压缩**：
  - 大于 5MB 的图片自动压缩并转换为 JPG。
  - 小图保持原样，节省流量。
- **⚡️ 增量更新**：
  - **洗图脚本**：每小时运行一次，仅扫描过去 **2小时内** 编辑过的文章，极速且省资源。
  - **封面脚本**：每天运行一次，全量检查或补充缺失封面。
- **🚀 国内加速**：图片链接自动转换为 `jsDelivr` CDN，国内访问速度极快。

## 🔧 准备工作

1. **Notion 设置**：
   - 创建一个 [Notion Integration](https://www.notion.so/my-integrations)。
   - 将 Integration 邀请至你的 Database 页面（点击页面右上角 `...` -> `Connect`）。
   - 获取 `Database ID`。
2. **GitHub 图床设置**：
   - 创建一个 **Public** 仓库用来存图（推荐专门建一个，如 `notion-images`）。
   - 获取一个 `Fine-grained token` 或 `Classic Token` (权限需包含 `repo` 或 `contents: write`)。

## ⚙️ 环境变量 (Secrets)

在 GitHub 仓库的 **Settings** -> **Secrets and variables** -> **Actions** 中添加以下 Repository secrets：

| Key | 说明 | 示例 |
| :--- | :--- | :--- |
| `NOTION_TOKEN` | Notion Integration Token | `secret_xxxx...` |
| `DATABASE_ID` | 你的 Notion 数据库 ID | `32位字符` |
| `GH_TOKEN` | GitHub Personal Access Token | `github_pat_xxx...` |
| `IMAGE_REPO` | 存图的仓库 (用户名/仓库名) | `perinchiang/notion-image-bed` |
| `IMAGE_BRANCH` | 存图的分支 | `main` |

## 🛠 工作流说明

本项目包含两个自动化 Workflow：

### 1. `wash-content.yml` (每小时运行)
- **作用**：清洗正文图片。
- **逻辑**：每小时自动唤醒，检查 Database 中 `Last edited time` 在过去 2 小时内的文章。
- **行为**：
  - 发现 Notion 原生图 -> 下载 -> 上传 GitHub -> 替换链接。
  - 发现非本图床的外链 -> 下载 -> 上传 GitHub -> 替换链接。
  - 发现自家图床链接但格式是 Raw -> 修复为 CDN 格式。

### 2. `auto-cover.yml` (每天 06:00 运行)
- **作用**：同步页面封面。
- **逻辑**：遍历所有文章。
- **行为**：
  - 如果文章没有封面 -> 抓取正文第一张图 -> 上传 GitHub -> 设置为 Notion 封面。
  - 如果代码中开启 `FORCE_UPDATE`，则会强制更新所有封面。

## ❓ 常见问题

**Q: 为什么刚写完文章图片没有马上变？**
A: 洗图脚本设置为**每小时**运行一次。你可以手动去 GitHub Actions 页面点击 `Notion Auto Wash` -> `Run workflow` 立即触发。

**Q: 如何强制重新处理所有文章的图片？**
A: 修改 `wash_content.js` 中的 `timeWindow` 逻辑，或者临时去除时间过滤条件。但建议仅在必要时操作，以免触发 Notion API 速率限制。

**Q: 图片上传后变成了 `jsDelivr` 链接？**
A: 是的，为了保证国内访问速度和稳定性，脚本会自动返回 `https://cdn.jsdelivr.net/gh/user/repo...` 格式的链接。

## 📄 License

MIT
