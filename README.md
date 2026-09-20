# dsh-effort-ultra

给 DeepSeek Harness composer 使用的原生推理强度控件。它把模型选择和 reasoning effort
都接到 DSH 官方会话服务上，提供接近 Codex 的蓝紫渐变 UI，同时保留旧插件的业务逻辑。

> A native reasoning-effort control for the DeepSeek Harness composer. It uses the official
> DSH session services for model and effort selection, with a Codex-style blue-to-violet UI.

## 功能

- **连续滑动**：按住 thumb 一次即可连续拖动，拖动和点击滑条都会立即提交档位。
- **六档 Step Agent**：`off`、`low`、`medium`、`high`、`xhigh`、`Ultra`。
- **显式档位菜单**：档位旁的三角按钮可以直接选择“跟随模型默认”或任意可用档位，首次使用无需猜操作方式。
- **模型切换**：目录中有多个模型时，卡片内提供模型选择器；切换和档位修改都写入当前 DSH 会话。
- **跟随默认与关闭**：回旋箭头或菜单中的“跟随模型默认”会清除显式档位；`off` 是真正提交给会话服务的关闭档位。
- **原生状态同步**：读取官方模型目录和会话 projection，模型切换、外部修改、重新打开面板都会显示当前真实状态。
- **主题适配**：浅色/深色主题各有一套配色；系统开启“减弱动效”时会停用星点和流光。

控件占用 `conversation.input.model` 座位（priority `-20`）。如果同时安装了旧的第三方档位控件，
本插件会优先显示；卸载后座位会正常释放。

## 档位如何决定

每个模型支持的档位来自 DSH 官方模型目录中的 `reasoning` 声明，插件不会猜测或伪造档位：

```js
{
  defaultEffort: 'high',
  efforts: [
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' }
  ]
}
```

如果模型没有声明 `defaultEffort`，界面会显示“跟随模型默认”。例如当前的
`step-5-preview` 没有默认档位声明，所以切换到它时显示跟随默认是正确状态；点击三角菜单或滑条即可选择一个显式档位。

## 安装

从 GitHub 安装：

```bash
dsh plugin --profile <你的 profile> add github:LoveIrishCoffee/dsh-effort-ultra
```

将来发布到 npm 并被市场目录收录后，也可以使用包名安装：

```bash
dsh plugin --profile <你的 profile> add dsh-effort-ultra
```

安装后重启 DSH。

## 技术实现

插件不依赖旧插件，也不修改其他插件的界面。浏览器半边使用 DSH 官方服务：

- `remote.session.modelCatalog`：读取可用模型及其 reasoning 声明；
- `remote.session.selectModel`：提交模型和 reasoning effort；
- `sessions`：读取当前会话 projection；
- `slots`：注册 composer 座位。

`off`、六档 Step 值以及“跟随模型默认”都通过官方会话选择路径保存，刷新或切换会话后仍以宿主真实状态为准。

## 开发与验证

```bash
npm install
npm run build
npm test
npm run typecheck
npm run check:dist
```

测试使用宿主服务 stub 加载真实的 `lib/client.js`，覆盖座位注册、目录读取、模型切换、连续拖动、六档菜单、
默认值恢复、错误提示、卸载清理和包契约检查，不需要浏览器。

## 授权

MIT
