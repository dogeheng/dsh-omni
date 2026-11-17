.PHONY: help start stop restart status
.DEFAULT_GOAL := help

help:
	@printf '%s\n' 'macOS QQ 机器人管理：' '  make start    启动 Docker、SnowLuma、DSH 和桥接' '  make stop     停止桥接、SnowLuma 和 DSH' '  make restart  关闭后重新启动' '  make status   查看运行状态'

start stop restart status:
	@node packages/bridge/scripts/stack-mac.mjs $@
