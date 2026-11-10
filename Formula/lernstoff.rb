class Lernstoff < Formula
  desc "Headless Cognitive Selective Note-Taking Engine & Daemon for AI Agents and Obsidian"
  homepage "https://github.com/JsonLee12138/lernstoff-wiki"
  url "https://registry.npmjs.org/@lernstoff/cli/-/cli-0.1.0-beta.4.tgz"
  sha256 "ee3cae255f0f9e4c57d0f20b2d709acb7461cc12d2bd4394f69d5c687db0b442"
  license "MIT"

  depends_on "node@22"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "lernstoff", shell_output("#{bin}/lernstoff --version")
  end
end
