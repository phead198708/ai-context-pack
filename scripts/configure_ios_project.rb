#!/usr/bin/env ruby
require 'xcodeproj'

project_path = File.expand_path('../ios/AIContextPack.xcodeproj', __dir__)
project = Xcodeproj::Project.open(project_path)
main_target = project.targets.find { |target| target.name == 'AIContextPack' } or abort 'AIContextPack target missing'
extension_target = project.targets.find { |target| target.name == 'ShareExtension' }

unless extension_target
  extension_target = project.new_target(:app_extension, 'ShareExtension', :ios, '16.4')
  group = project.main_group.find_subpath('ShareExtension', true)
  group.set_source_tree('<group>')
  group.path = 'ShareExtension'
  %w[ShareViewController.swift MainInterface.storyboard].each do |name|
    reference = group.new_file(name)
    name.end_with?('.swift') ? extension_target.add_file_references([reference]) : extension_target.resources_build_phase.add_file_reference(reference)
  end
  main_target.add_dependency(extension_target)
  copy_phase = main_target.new_copy_files_build_phase('Embed App Extensions')
  copy_phase.symbol_dst_subfolder_spec = :plug_ins
  copy_phase.add_file_reference(extension_target.product_reference)
end

extension_group = project.main_group.groups.find { |group| group.display_name == 'ShareExtension' }
extension_group.path = 'ShareExtension' if extension_group

shared_extension_sources = %w[
  InboxWriterOwnership.swift
  InboxManifestValidator.swift
  ShareIngestion.swift
]
shared_extension_sources.each do |name|
  path = "../../modules/context-native/ios/#{name}"
  reference = extension_group.files.find { |file| file.path == path }
  unless reference
    reference = extension_group.new_file(path)
    reference.name = name
  end
  unless extension_target.source_build_phase.files_references.include?(reference)
    extension_target.add_file_references([reference])
  end
end

main_target.build_configurations.each do |config|
  config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.example.aicontextpack'
  config.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'AIContextPack/AIContextPack.entitlements'
  config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '16.4'
end
extension_target.build_configurations.each do |config|
  config.build_settings['PRODUCT_NAME'] = 'ShareExtension'
  config.build_settings['EXECUTABLE_NAME'] = 'ShareExtension'
  config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.example.aicontextpack.ShareExtension'
  config.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'ShareExtension/ShareExtension.entitlements'
  config.build_settings['INFOPLIST_FILE'] = 'ShareExtension/Info.plist'
  config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '16.4'
  config.build_settings['SWIFT_VERSION'] = '5.0'
  config.build_settings['TARGETED_DEVICE_FAMILY'] = '1,2'
  config.build_settings['SKIP_INSTALL'] = 'YES'
end
project.save
