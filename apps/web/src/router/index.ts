import { createRouter, createWebHistory } from 'vue-router'
import { api } from '../lib/api'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('../pages/LoginPage.vue'), meta: { public: true } },
    {
      path: '/',
      component: () => import('../components/AppLayout.vue'),
      children: [
        { path: '', component: () => import('../pages/DashboardPage.vue') },
        { path: 'products', component: () => import('../pages/ProductsPage.vue'), meta: { module: 'product' } },
        { path: 'partners', component: () => import('../pages/PartnersPage.vue') },
        { path: 'warehouses', component: () => import('../pages/SimpleListPage.vue'), props: { kind: 'warehouse' } },
        { path: 'funds', component: () => import('../pages/SimpleListPage.vue'), props: { kind: 'fund' }, meta: { module: 'finance' } },
        { path: 'docs/:type', component: () => import('../pages/DocListPage.vue') },
        { path: 'docs/:type/new', component: () => import('../pages/DocEditPage.vue') },
        { path: 'docs/:type/:id', component: () => import('../pages/DocEditPage.vue') },
        { path: 'stock', component: () => import('../pages/StockPage.vue'), meta: { module: 'inventory' } },
        { path: 'reports', component: () => import('../pages/ReportsPage.vue'), meta: { module: 'report' } },
        { path: 'settings', component: () => import('../pages/SettingsPage.vue') },
        { path: 'settings/:tab', component: () => import('../pages/SettingsPage.vue') },
      ],
    },
  ],
})

router.beforeEach(async (to) => {
  if (to.meta.public) return true
  if (!(await api.token())) return { path: '/login', query: { redirect: to.fullPath } }
  return true
})
