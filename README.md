# 躺平发育 · Lying Flat: Dorm Defense

一款**纯前端、零依赖、免构建**的塔防小游戏：你躺在宿舍左下角的床上躺平赚金币，在整间宿舍里造 31 种建筑，挡住从右侧三扇房门冲进来的 15 波猛鬼。

A zero-dependency, build-free browser tower-defense game: lie on your bed to earn gold, build 31 kinds of structures, and survive 15 waves of ghosts storming in through the three doors on the right.

## 在线试玩 / Play online

> 部署到 GitHub Pages 后，把下面的地址换成你的仓库地址即可：
> `https://<你的用户名>.github.io/<仓库名>/`

## 玩法 / How to play

| | |
|---|---|
| 🛏️ 床 / Bed | 每秒自动产金币，可升到 Lv.5（收益 3 → 18/s） |
| 💰 经济 / Economy | 矿机产金、金库按比例加成全体收益 |
| ⚡ 电力 / Power | 发电机提供电力上限；**电力不足时耗电建筑全部停机** |
| 🏗️ 建筑 / Buildings | **31 种**，**每种可升到 Lv.12** — 见下方列表 |
| 🌊 波次 / Waves | 15 波；通关后可进无尽模式 |
| 👑 王 / King | **每 5 关降临一个王**：血量 = 关卡数 × 100，**原地不动**，每 5 秒产出 **关卡数 × 2** 只小鬼，**打不死就一直在**（不挡后续波次） |
| ❤️ 失败条件 | 床被猛鬼啃翻（床位耐久归零） |

## 31 种建筑 / 31 buildings

| 类别 | 建筑 | 作用 |
|---|---|---|
| 攻击 | 💥 炮台 | 单体速射 |
| 攻击 | 🎯 狙击塔 | 超远程射线，优先狙杀最靠近床的鬼 |
| 攻击 | 🔥 火焰塔 | 扇形喷射，群体灼烧 |
| 攻击 | 🧊 冰霜塔 | 命中减速，1.5 秒 |
| 攻击 | ⚡ 电磁塔 | 闪电连锁多个目标 |
| 攻击 | 🪤 陷阱板 | 踩到即触发高额伤害 |
| 攻击 | 💣 炸弹桶 | 定时引爆，圆形范围全体伤害 |
| 攻击 | ☠️ 毒气塔 | 毒云持续伤害，中毒 3 秒 |
| 攻击 | 🔆 聚能塔 | 持续射线，锁定越久伤害越高（最高 +54%） |
| 攻击 | 🌀 磁暴塔 | 脉冲击退 + 短暂眩晕 |
| 攻击 | ⏳ 滞缓力场 | 范围内猛鬼持续减速 |
| 攻击 | 🛸 无人机 | 会飞的移动炮台，自动追击开火 |
| 防御 | 🧱 路障 | 堵路，猛鬼必须先拆 |
| 防御 | 🎭 诱饵床 | 吸引 3 格内猛鬼优先来啃 |
| 经济 | ⛏️ 矿机 | 每秒产金 |
| 经济 | 🏦 金库 | 全体收益百分比加成 |
| 经济 | 💹 利息银行 | 按存款每秒计息（复利） |
| 电力 | 🔋 发电机 | 提高电力上限 |
| 电力 | ⚙️ 变压器 | 全体建筑耗电降低 |
| 攻击 | 🔺 尖刺地板 | 踩上去就一直掉血 |
| 攻击 | 🌀 传送门 | 把推进最深的猛鬼传送回门口重走 |
| 攻击 | ❄️ 急冻仓 | 定期冻结范围内猛鬼 |
| 攻击 | ⏰ 时钟塔 | 每 18 秒全场慢放，持续 4 秒 |
| 防御 | 👮 保安 | 近战肉盾，有耐久，阵亡 8 秒后复活 |
| 辅助 | 🩹 医疗站 | 定期修复床位 |
| 辅助 | 🔧 维修间 | 范围内塔攻速加成 |
| 辅助 | 🛡️ 护盾器 | 床位上限提升 + 每秒自愈 |
| 辅助 | 🔊 增幅器 | 范围内攻击塔伤害加成 |
| 辅助 | 📡 雷达 | 全场塔射程加成 |
| 辅助 | 🎲 暴击核心 | 全场攻击概率打出 3 倍暴击 |
| 辅助 | 🔦 聚光灯 | 标记范围内猛鬼，使其受到伤害提升 |

## 操作 / Controls

- `1`~`9`、`0` 选择前 10 个建造项（其余点击卡片）
- 点击空地放置建筑；点击已有建筑可升级 / 拆除（回收 60%）
- `Esc` 或右键取消选择
- `空格` 切换 1x / 2x / 3x 速度
- `P` 暂停 / 继续
- `L` 切换中文 / English（或点右上角 `EN 🌐`）

Hotkeys: `1`~`0` pick a build · click empty tile to place · click a building to upgrade or sell (60% refund) · `Esc` / right-click cancel · `Space` change speed · `P` pause · `L` switch language.

## 本地运行 / Run locally

三种方式任选其一 / Pick any one:

```bash
# 1) 直接双击打开（纯静态，无需服务器）
#    Just open index.html in your browser

# 2) Python
python -m http.server 8000

# 3) Node
npx serve .
```

然后访问 / Then visit `http://localhost:8000`。

## 部署到 GitHub Pages / Deploy

1. 新建仓库并把本目录推上去：
   ```bash
   git init
   git add .
   git commit -m "躺平发育 网页版"
   git branch -M main
   git remote add origin https://github.com/<用户名>/<仓库名>.git
   git push -u origin main
   ```
2. 仓库 **Settings → Pages → Build and deployment**：
   - **Source** 选 **Deploy from a branch**
   - **Branch** 选 `main`、**Folder** 选 `/ (root)`
   - 点 **Save**
   （纯静态站，根目录就是 `index.html`，之后每次 push 到 `main` 都会自动重新部署。）
3. 一两分钟后访问 `https://<用户名>.github.io/<仓库名>/`。

也可以部署到任意静态托管：Vercel（`npx vercel --prod`）、Cloudflare Pages（`npx wrangler pages deploy .`）、Netlify（拖拽目录）。

## 项目结构 / Structure

```
index.html   页面骨架（HUD / Canvas / 建造栏 / 弹窗）
style.css    UI 样式
game.js      全部游戏逻辑与 Canvas 渲染
i18n.js      中英文文案（新增语言只需加一份同结构对象）
favicon.svg  站点图标
.nojekyll    禁用 Jekyll 处理（Pages 从分支部署时需要）
```

## 技术栈 / Tech

原生 HTML + CSS + JavaScript（ES2015+），Canvas 2D 渲染，无框架、无构建工具、无后端、无网络请求。桌面端体验最佳（未做触屏适配）。

Vanilla HTML/CSS/JS, Canvas 2D, no framework, no build step, no backend. Optimised for desktop (no touch controls yet).

## License

[MIT](LICENSE) © 2026 Tangping Defense contributors
