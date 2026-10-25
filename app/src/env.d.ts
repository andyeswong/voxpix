declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}
declare module '*.png' {
  const url: string;
  export default url;
}
declare module '*.json' {
  const value: unknown;
  export default value;
}
