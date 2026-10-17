import { Languages } from 'lucide-react';
import { useLocale,type Language } from '../i18n';

export default function LanguageSwitch(){
  const {language,setLanguage}=useLocale();
  return <label className="language-switch"><Languages size={16} aria-hidden="true"/><span className="sr-only">Language / Kieli</span><select aria-label="Language / Kieli" value={language} onChange={event=>setLanguage(event.target.value as Language)}><option value="en" lang="en">English</option><option value="fi" lang="fi">Suomi</option></select></label>;
}
