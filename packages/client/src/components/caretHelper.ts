export function getCaretCoordinates(element: HTMLTextAreaElement, position: number) {
  const div = document.createElement('div')
  const style = window.getComputedStyle(element)
  
  for (const prop of Array.from(style)) {
    div.style.setProperty(prop, style.getPropertyValue(prop))
  }
  
  div.style.position = 'absolute'
  div.style.visibility = 'hidden'
  div.style.whiteSpace = 'pre-wrap'
  div.style.wordWrap = 'break-word'
  div.style.overflowWrap = 'break-word'
  
  const textContent = element.value.substring(0, position)
  div.textContent = textContent

  const span = document.createElement('span')
  span.textContent = element.value.substring(position) || '.'
  div.appendChild(span)

  document.body.appendChild(div)
  
  const coordinates = {
    top: span.offsetTop,
    left: span.offsetLeft,
    height: parseInt(style.lineHeight || style.fontSize || '20')
  }
  
  document.body.removeChild(div)
  return coordinates
}
