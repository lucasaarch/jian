//! The helper on its own, as the Node worker runs it. Jian Remote runs the same code as
//! `jian-remote computer-helper`.

fn main() {
    jian_computer_use::helper_main(std::env::args().skip(1));
}
