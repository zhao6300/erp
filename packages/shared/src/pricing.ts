import { Dec, DecValue, dec, roundHalfUp } from './decimal'
import type { PriceLevel } from './types'

export interface PricedProduct {
  refSalePrice: DecValue
  wholesalePrice?: DecValue | null
}

/** 价格等级取价(需求 12.4) */
export function resolveUnitPrice(product: PricedProduct, level: PriceLevel, priceScale: number): Dec {
  switch (level.type) {
    case 'retail':
      return roundHalfUp(product.refSalePrice, priceScale)
    case 'wholesale': {
      const w = product.wholesalePrice
      return roundHalfUp(w === null || w === undefined || w === '' ? product.refSalePrice : w, priceScale)
    }
    case 'discount':
      return roundHalfUp(dec(product.refSalePrice).times(dec(level.rate)).div(100), priceScale)
  }
}
