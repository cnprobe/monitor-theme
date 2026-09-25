// 玩家面板上方的自定义页脚。只渲染管理员填写的纯文本，不请求访客地理信息。

function element(root, id) {
  return root?.getElementById?.(id) || root?.querySelector?.(`#${id}`) || null;
}

function safeText(value, max = 200) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ').trim().slice(0, max)
    : '';
}

export function mountFooter({
  root = typeof document === 'object' ? document : null,
  text = '',
} = {}) {
  const footer = element(root, 'me-footer');
  const content = element(root, 'footer-text');
  if (!footer || !content) return () => {};

  const value = safeText(text);
  footer.hidden = !value;
  content.textContent = value;
  return () => {};
}
