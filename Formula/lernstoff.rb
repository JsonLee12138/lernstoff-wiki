class Lernstoff < Formula
  desc "Headless Cognitive Selective Note-Taking Engine & Daemon for AI Agents and Obsidian"
  homepage "https://github.com/jsonlee/lernstoff-wiki"
  url "https://registry.npmjs.org/@lernstoff/cli/-/cli-0.1.0-beta.3.tgz"
  sha256 "7725f0b3676adb5d521fcc96187f32d340b9af5211be2dbf4df4c5d2051a63c0"
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
