require 'digest'

# Expo's precompiled-module podspec and React Native's Hermes podspec embed the
# absolute checkout path in generated Local Podspec JSON. CocoaPods hashes that
# JSON verbatim, which otherwise makes Podfile.lock differ between a developer
# checkout and GitHub's runner even though the dependency content is identical.
# This module normalizes only the checkout-root portion of checksum input; the
# evaluated specification keeps its real paths for downloads and build settings.
module DeterministicWorkspacePodspecChecksum
  PLACEHOLDER = '${PROJECT_ROOT}'.freeze
  WORKSPACE_DEPENDENT_PODS = %w[ExpoModulesCore hermes-engine].freeze

  def self.normalize(contents, checkout_root)
    expanded_root = File.expand_path(checkout_root)
    checkout_roots = [expanded_root]
    checkout_roots << File.realpath(expanded_root) if File.exist?(expanded_root)
    checkout_roots.uniq.sort_by { |path| -path.length }.reduce(contents) do |value, path|
      value.gsub(path, PLACEHOLDER)
    end
  end

  def checksum
    return super unless root? && WORKSPACE_DEPENDENT_PODS.include?(name)
    return super unless defined_in_file && File.file?(defined_in_file)

    contents = File.binread(defined_in_file)
    checkout_root = File.expand_path('..', Pod::Config.instance.installation_root.to_s)
    normalized = DeterministicWorkspacePodspecChecksum.normalize(contents, checkout_root)

    return super if normalized == contents

    @deterministic_workspace_checksum ||= Digest::SHA1.hexdigest(normalized).encode('UTF-8')
  end
end

Pod::Specification.prepend(DeterministicWorkspacePodspecChecksum)
