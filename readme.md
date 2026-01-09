# Notion Auto Cover Sync

自动从 Notion 页面里提取第一张图片，上传到 GitHub Repo 作为图床，然后更新 Notion 页面封面。

## ⭐ 功能

- 自动获取 Notion 第一张图片
- 支持 GitHub Repo 作为图床
- 自动上传并返回永久 URL
- 更新 Notion Cover 属性
- GitHub Actions 定时执行

## 🔧 配置步骤

1️⃣ 创建 Notion Integration  
2️⃣ 获取 Notion Token & Database ID  
3️⃣ 创建 GitHub Repo 作为图床（Public）  
4️⃣ 创建 GH_TOKEN（Fine-grained）  
5️⃣ 配置 GitHub Secrets  
6️⃣ 推送代码并运行 Actions

---

## ⚙️ Secrets（仓库 Settings → Secrets）

| Key | 用途 |
|-----|------|
| NOTION_TOKEN | Notion API Token |
| DATABASE_ID | Notion 数据库 ID |
| GH_TOKEN | GitHub 图床上传 Token |
| IMAGE_REPO | 图床 Repo（例：user/notion-image-bed） |
| IMAGE_BRANCH | 分支（main） |

---

## 🛠 使用方法

1. Push 代码到 GitHub  
2. 手动执行 workflow（Run）  
3. 定时自动执行（06:00）

## ✏️ 使用建议
- 如果图床被删掉、图裂了、找不到原图了，可以把 `const FORCE_UPDATE = false` 临时改为true。
- 运行成功、确认所有封面都正常显示后，建议改回来`const FORCE_UPDATE = false`
- 这样以后定时任务跑的时候，就不会重复处理旧文章，只处理新增的、没有封面的文章，节省 GitHub Actions 的时间和资源。

---

## 📈 效果示例

🚀 更新后的 Notion 页面封面：  
![实例](https://images-1314261959.cos.ap-guangzhou.myqcloud.com/img/20260109094934009.png)

---

## 📄 License

MIT
