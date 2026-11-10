class Lernstoff < Formula
  desc "Headless Cognitive Selective Note-Taking Engine & Daemon for AI Agents and Obsidian"
  homepage "https://github.com/JsonLee12138/lernstoff-wiki"
  url "https://registry.npmjs.org/@lernstoff/cli/-/cli-0.1.0-beta.6.tgz"
  sha256 "8aa4ae81ba94b1b14180789cb4f5ed63156eaf8c763a93504434679665c20949"
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
