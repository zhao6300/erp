// 仅用于在没有 @dcloudio/* 工具链的环境里对页面做类型检查(vue-tsc)。
// 真实构建使用 @dcloudio/types 与 @dcloudio/uni-app 提供的声明,不要在装好工具链后保留本文件。
declare module '@dcloudio/uni-app' {
  export function onLoad(cb: (query: Record<string, string>) => void): void
  export function onShow(cb: () => void): void
  export function onLaunch(cb: () => void): void
}
