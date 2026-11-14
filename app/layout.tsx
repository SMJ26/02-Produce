import type {ReactNode} from 'react'
import './studio.css'

export const metadata = {title: 'Cutline Studio', description: 'Create a narrated explainer from a topic.'}
export default function Layout({children}: {children: ReactNode}) {
  return <html lang="en"><body>{children}</body></html>
}
