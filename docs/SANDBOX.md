# Agent 文件工作区（sandbox）

这是一个**受限文件工作区**，不是完整虚拟机。它解决「agent 读写文件时不要越界」，
不提供 shell、网络或宿主目录访问；需要执行命令/浏览器时，应再接 Linux VM 或容器。

## 目录

默认：

```text
~/dsh-sandbox/
  workspace/      # agent 唯一可读写的工作区（0700）
  exchange/       # 人工交换文件（0700；不暴露给 MCP）
```

初始化：

```bash
npm --prefix packages/bridge run setup:sandbox
```

也可以用 `socialV2.sandbox.root` 指定其他位置，例如项目外的独立磁盘目录。

## 配置

```json
"socialV2": {
  "sandbox": {
    "enabled": true,
    "root": "",
    "maxReadBytes": 1048576,
    "maxWriteBytes": 1048576,
    "maxEntries": 500
  }
}
```

`root` 为空时使用 `~/dsh-sandbox`。修改后需要重启 DSH，MCP 工具才会重新注册。

## 工具

只暴露文件操作，不提供 `exec`：

- `sandbox_info`：查看工作区路径与配额；
- `sandbox_list(path)`：列目录；
- `sandbox_read(path)`：读文本（UTF-8，大小上限）；
- `sandbox_write(path, content, append?)`：写文本；
- `sandbox_mkdir(path)`：建目录；
- `sandbox_delete(path)`：删除**单个普通文件**，不删目录、不递归。

路径规则：

- 必须是工作区相对路径；
- 拒绝绝对路径、盘符、`..`、NUL；
- 逐段 `lstat` 拒绝 symlink；
- 最终文件用 `O_NOFOLLOW` 打开；
- 读/写大小、目录条目数有上限；
- 删除只允许普通文件。

## 这层能防什么

- agent 被群消息诱导去读 `~/.ssh`、`config.json`、`data/`：没有路径可传，绝对路径/`..`/symlink 都会被拒绝；
- 误删目录：拒绝；误覆盖大文件：大小上限；
- 跨出 workspace 写文件：父目录必须已存在且在 workspace 内。

## 这层不能防什么

**没有 shell 隔离。** 如果 agent 同时拥有宿主机的 `bash` / `exec` 工具，
它仍然可以用 `cat /Users/...` 绕过文件工具。因此：

- QQ preset 只挂 MCP 的 `sandbox_*`，不要同时挂宿主 `bash`；
- 需要真正执行命令/浏览器时，使用 Linux VM/容器，把 workspace 作为唯一挂载；
- 不要把 `config.json`、API Key、QQ token、SSH key 放进 workspace。

## 测试

```bash
npm --prefix packages/bridge run test-sandbox
```

覆盖读写、目录、删除、绝对路径、`..`、NUL、symlink 逃逸、越界写入、
文件大小上限和 MCP 工具注册名。真实边界建议再补：容器内 `cat /Users/...`、
宿主网络访问、Docker socket 和资源炸弹测试。
