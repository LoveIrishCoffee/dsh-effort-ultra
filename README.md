# dsh-effort-ultra

给 DeepSeek Harness 的 composer 提供一个**原生**的推理档位控件：一条**蓝→紫渐变胶囊**，
里面撒着星点、每 2.6 秒有一道柔光扫过。

> A native reasoning-effort control for the DSH composer: a blue→violet tier bar
> with a starfield and a sheen sweep.

**"原生"是字面意思：它不依赖任何第三方插件，也不去改别人画的界面。**
它自己占住 `conversation.input.model` 座位，只对 DSH **官方**的
`modelDirectories` 服务编程。

---

## 它长什么样

折叠态是 composer 里的一枚小胶囊（模型名 + 当前档位）；点开是完整面板：

- **档位条**：每个档位一段，当前档位及以下填充蓝紫渐变 + 星点 + 流光
- **档位标签行**：由模型自己声明的档位生成
- **模型下拉**：有多个 provider 时可直接换模型
- **「跟随模型默认」**：把显式档位选择清掉，回落到模型的默认档

浅色/深色主题各一套配色。系统开启「减弱动效」时星点与流光自动停用。

## 关键设计：档位不是我们定的

**每个模型支持哪些档位，由模型自己的 `reasoning` 声明决定**，我们从官方目录读出来：

```js
model.reasoning = {
  defaultEffort: 'high',                                  // 该模型的默认档
  efforts: [ { id: 'low', name: 'Low' }, … { id: 'ultra', name: 'Ultra' } ]
}
```

所以：

- 有的模型到 **Ultra**，有的只到 **Max** —— **天然正确**，不是我们写死的
- `efforts[].name` 是**宿主已经本地化好**的显示名，所以本插件**不携带任何档位词表**，
  换语言不用我们改代码
- 模型改了声明，界面自动跟着变

档位的**配置入口**是 DSH 官方设置（「模型」页里每个模型那一行的推理等级字段）。
本插件**不重复造那个设置页** —— 官方已有该字段，市面上也已有若干插件在做它的编辑器。

## 安装

```bash
dsh plugin --profile <你的 profile> add dsh-effort-ultra
```

从 GitHub 装也可以（`dist/` 跟着仓库提交，无需本地构建）：

```bash
dsh plugin --profile <你的 profile> add github:LoveIrishCoffee/dsh-effort-ultra
```

重启 DSH 后生效。

## 它占用哪个座位

`conversation.input.model`，**priority `-20`**。

DSH 的 single 座位规则是**数字越小越优先**（源码注释原文：`lowest renders`）：

| 注册者 | priority |
|---|---|
| **本插件** | **-20** ← 生效 |
| 常见的第三方档位控件 | -10 |
| DSH 自带的模型选择器 | 0 |

所以本插件会接管这个座位。**如果你同时装了别的档位控件，装本插件后以本插件为准；
把它卸掉，别的控件会自己回来** —— 注销走 `ctx.effect` 清理，不留残留。

## 它依赖什么

| | |
|---|---|
| 第三方插件 | **零** |
| 官方客户端服务 | `modelDirectories`（档位与选择）、`slots`（座位注册）；`locale`、`sessions` 为可选 |
| 宿主半边 | **没有实际逻辑** —— 惰性，只为了让包在组合树里有一行 |

## 开发

```bash
npm install
npm run build      # tsc: src/index.ts -> dist/index.js（宿主半边）
npm test           # 自检（25 项）+ 包契约校验
npm run typecheck
npm run check:dist # 确认提交的 dist/ 与 src/ 一致
```

`npm test` 里的 `scripts/smoke-client.mjs` **不需要浏览器**：它用一个 stub React
（自己实现 hook 帧，能触发重渲染）和一个假的 `modelDirectories`，把
`lib/client.js` 真正加载起来，然后断言：

- 座位注册在 `conversation.input.model`、priority 是 `-20`
- `inject` 拿到官方 store，并正确报告可用性
- 渲染出**宿主声明的档位数量**的段落（不是写死的 4）
- 点击档位提交的是 `{ provider, model, reasoningEffort }`，**三个字段都对**
- 「跟随模型默认」提交时**不带** `reasoningEffort`（让模型默认生效）
- 模型没有档位声明时渲染提示文字，而不是一条坏掉的条
- 卸载后 `<style>` 被移除

`scripts/check-package-contract.mjs` 另外守住一条**架构约束**：
客户端代码里**不允许出现任何上游插件的痕迹**（`@hytime`、`data-seat-` 等），
确保"原生"是事实而不是说法。

## 授权

MIT
