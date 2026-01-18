import { createContext, useContext, useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import type { Language } from './translations'
import { translations } from './translations'

type TranslationKey = keyof typeof translations.fr

interface I18nContextType {
  language: Language
  setLanguage: (lang: Language) => void
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
  availableLanguages: Language[]
}

const I18nContext = createContext<I18nContextType | undefined>(undefined)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => {
    const saved = localStorage.getItem('ridiwave-language')
    if (saved && (saved === 'fr' || saved === 'en' || saved === 'es' || saved === 'de' || saved === 'ja')) {
      return saved as Language
    }
    return 'en'
  })

  useEffect(() => {
    localStorage.setItem('ridiwave-language', language)
  }, [language])

  const setLanguage = (lang: Language) => {
    setLanguageState(lang)
  }

  const t = (key: TranslationKey, params?: Record<string, string | number>): string => {
    const text = translations[language][key]
    if (!params) return text
    return text.replace(/\{(\w+)\}/g, (match, paramKey) => {
      return params[paramKey]?.toString() ?? match
    })
  }

  return (
    <I18nContext.Provider
      value={{
        language,
        setLanguage,
        t,
        availableLanguages: ['fr', 'en', 'es', 'de', 'ja'],
      }}
    >
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n() {
  const context = useContext(I18nContext)
  if (!context) {
    throw new Error('useI18n must be used within I18nProvider')
  }
  return context
}
