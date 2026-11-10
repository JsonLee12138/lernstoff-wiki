class Lernstoff < Formula
  desc "Headless Cognitive Selective Note-Taking Engine & Daemon for AI Agents and Obsidian"
  homepage "https://github.com/jsonlee/lernstoff-wiki"
  url "https://registry.npmjs.org/@lernstoff/cli/-/cli-0.1.0-beta.4.tgz"
  sha256 "1ecfab509fa4003a311dc227240cf6b401c6c54dde053889ffff04f62ade75b9"
  license "MIT"

  depends_on "node@22"

  def install
    system "npm", "install", *std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "lernstoff", shell_output("#{bin}/lernstoff --version")
  end
end
