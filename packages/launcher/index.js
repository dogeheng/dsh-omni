// dsh-omni-launcher —— Host 半端。
//
// 这个插件只负责界面入口，没有任何 Host 服务需要注册：三个地址都是本机
// （noVNC / SnowLuma / 桥接控制台）的普通网页，由浏览器直接打开。
// 保留一个空的 apply 是为了满足 bundle 行必须可挂载的约定。
export function apply() {}
