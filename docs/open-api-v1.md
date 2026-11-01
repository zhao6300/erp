# 开放接口 /open/v1

供外部系统(电商、自有系统)读写商品、往来单位、库存和单据。v1 的响应字段固定:已发布字段不会删除或改名,只会新增。

## 认证

```
Authorization: Bearer <keyId>.<secret>
```

- 访问密钥由租户管理员在后台创建,`secret` 只在创建时返回一次,服务端只存哈希。
- 密钥哈希使用 `BACKUP_HMAC_SECRET` 计算。**更换该环境变量会使所有已发放的访问密钥失效。**
- 授权按密钥的 `scopes`(权限码,如 `product:view`、`sales_out:create`)判定,不继承管理员的全部权限。
- 认证失败返回 `OPEN_API_AUTH_FAILED`,`details[0].reason` 给出原因(缺少访问密钥、格式不正确、不存在、已停用、租户已停用)。
- 调用与租户接口走同一套 Service,因此字段校验、单据状态规则、模块开关、License 过期只读限制都一致。
- 必须通过 HTTPS 访问(反向代理设置 `X-Forwarded-Proto`)。

## 约定

- 金额、数量、单价都是**字符串**(例如 `"12.50"`),不要用浮点数解析。
- 错误响应:`{ "code": "...", "message": "...", "details": [...], "requestId": "..." }`。
- 分页参数 `page`(从 1 开始)、`pageSize`(默认 20,最大 100;`/stock` 默认 50)。
- 商品、库存接口要求对应模块(商品/库存)已启用;写接口在 License 过期后返回 `LICENSE_EXPIRED`(只读)。

## 接口

| 方法 | 路径 | 所需权限 | 说明 |
|---|---|---|---|
| GET | `/open/v1/products` | `product:view` | 商品列表(含 SKU) |
| POST | `/open/v1/products` | `product:create` | 创建商品 |
| GET | `/open/v1/partners` | `partner:view` | 客户/供应商列表 |
| POST | `/open/v1/partners` | `partner:create` | 创建往来单位 |
| GET | `/open/v1/stock` | 库存查看权限(由库存 Service 判定,含仓库数据范围) | 按 SKU、仓库的库存 |
| GET | `/open/v1/documents` | 按单据类型的查看权限(由单据 Service 判定) | 单据列表 |
| GET | `/open/v1/documents/:id` | 同上 | 单据详情(含明细) |
| POST | `/open/v1/documents` | 按单据类型的创建权限(由单据 Service 判定) | 保存单据。请求体可带 `clientRequestId`,同一个 id 重复提交不会生成重复单据 |
| POST | `/open/v1/documents/:id/audit` | 按单据类型的审核权限(由单据 Service 判定) | 审核单据,请求体需带 `version` |

各接口的请求体字段与租户接口 `/api/...` 相同,见 `packages/shared/src/schemas.ts`。响应字段由 `apps/server/src/http/open-api.ts` 中的 `mapXxxV1` 固定。

## 示例

```bash
curl -s https://erp.example.com/open/v1/products?pageSize=20 \
  -H "Authorization: Bearer ak_0123456789abcdef.SECRET"
```
