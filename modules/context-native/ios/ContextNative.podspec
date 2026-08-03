Pod::Spec.new do |s|
  s.name           = 'ContextNative'
  s.version        = '1.0.0'
  s.summary        = 'Local OCR, PDF, and Inbox bridge for AI Context Pack'
  s.description    = 'Passes controlled file URLs and versioned metadata DTOs across the native boundary.'
  s.author         = 'AI Context Pack contributors'
  s.homepage       = 'https://github.com/phead198708/ai-context-pack'
  s.platforms      = {
    :ios => '16.4',
  }
  s.source         = { git: 'https://github.com/phead198708/ai-context-pack.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
  s.exclude_files = ["Tests/**/*", "Package.swift"]
end
