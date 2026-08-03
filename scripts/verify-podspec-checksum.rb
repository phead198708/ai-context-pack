require 'digest'
require_relative '../ios/deterministic_workspace_podspec_checksum'

developer_root = '/Users/developer/Workspaces/ai-context-pack'
runner_root = '/Users/runner/work/ai-context-pack/ai-context-pack'

developer_spec = <<~JSON
  {
    "name": "SyntheticPod",
    "version": "1.0.0",
    "source": {"http": "file://#{developer_root}/node_modules/synthetic/pod.tar.gz"},
    "user_target_xcconfig": {"TOOL_PATH": "#{developer_root}/node_modules/tool/bin/tool"}
  }
JSON
runner_spec = developer_spec.gsub(developer_root, runner_root)

developer_normalized = DeterministicWorkspacePodspecChecksum.normalize(developer_spec, developer_root)
runner_normalized = DeterministicWorkspacePodspecChecksum.normalize(runner_spec, runner_root)
raise 'PODSPEC_CHECKSUM_PATH_VARIANCE' unless developer_normalized == runner_normalized

baseline_checksum = Digest::SHA1.hexdigest(developer_normalized)
runner_checksum = Digest::SHA1.hexdigest(runner_normalized)
raise 'PODSPEC_CHECKSUM_PATH_VARIANCE' unless baseline_checksum == runner_checksum

changed_spec = developer_spec.sub('1.0.0', '1.0.1')
changed_normalized = DeterministicWorkspacePodspecChecksum.normalize(changed_spec, developer_root)
raise 'PODSPEC_CHECKSUM_CONTENT_BLIND' if Digest::SHA1.hexdigest(changed_normalized) == baseline_checksum

puts 'PODSPEC_CHECKSUM pathIndependent=true contentSensitive=true result=pass'
